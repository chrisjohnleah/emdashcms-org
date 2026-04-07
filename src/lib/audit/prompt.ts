/**
 * AI audit prompt construction and code extraction.
 *
 * Builds the system prompt and user content for Workers AI code audits.
 * Extracts code files from plugin bundle tarballs using modern-tar.
 */
import { unpackTar, createGzipDecoder } from "modern-tar";
import type { AuditModelKey } from "../../types/marketplace";

/**
 * Metadata for each Workers AI model the audit pipeline can run. Keyed by
 * the friendly AuditModelKey carried on AuditJob; the consumer resolves
 * a key to its workersAiId here.
 *
 * Adding a new model: append a key to AuditModelKey in
 * src/types/marketplace.ts, then add an entry here. The admin Run AI
 * dropdown reads from this registry directly so new models surface in
 * the UI without further changes.
 */
export interface AuditModelDef {
  key: AuditModelKey;
  /** Full Workers AI model id passed to ai.run() */
  workersAiId: string;
  /** Short label shown on admin buttons */
  label: string;
  /** Tooltip / longer description of trade-offs */
  description: string;
  /** Approximate neuron cost per audit, for the admin UI */
  estimatedNeurons: string;
}

export const AUDIT_MODELS: Record<AuditModelKey, AuditModelDef> = {
  "llama-3.2-3b": {
    key: "llama-3.2-3b",
    workersAiId: "@cf/meta/llama-3.2-3b-instruct",
    label: "Llama 3.2 3B",
    description:
      "Default. Small (3B params) but capable enough for the lightweight audit we run. ~17 neurons/audit, ~588 audits/day on the free tier.",
    estimatedNeurons: "~17",
  },
  "gemma-4-26b-a4b": {
    key: "gemma-4-26b-a4b",
    workersAiId: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B-A4B",
    description:
      "Premium. Mixture-of-experts (26B total / ~4B active params) with 256k context, vision, function calling, and reasoning. Sharper findings on borderline plugins. Higher neuron cost — reserve for spot checks or when the cheap pass flagged.",
    estimatedNeurons: "~80-150",
  },
};

/**
 * Default model used when an audit job carries no modelOverride. Keep
 * this aligned with the cheapest viable model so the upload hot path
 * doesn't burn through the daily neuron budget.
 */
export const DEFAULT_AUDIT_MODEL: AuditModelKey = "llama-3.2-3b";

/**
 * Backwards-compatible alias for the default model's Workers AI id.
 * Existing tests and the legacy MODEL_ID import points still resolve
 * via this constant. New code should resolve through AUDIT_MODELS.
 */
export const MODEL_ID = AUDIT_MODELS[DEFAULT_AUDIT_MODEL].workersAiId;

/**
 * Resolve an AuditModelKey to its Workers AI model id. Unknown or
 * undefined keys fall back to the default model so a stale enum value
 * on a queued job never crashes the consumer.
 */
export function resolveAuditModel(
  key: AuditModelKey | undefined,
): AuditModelDef {
  if (key && key in AUDIT_MODELS) return AUDIT_MODELS[key];
  return AUDIT_MODELS[DEFAULT_AUDIT_MODEL];
}

/** File extensions to extract from bundles for AI analysis */
export const CODE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".json"]);

/**
 * File patterns we never want to ship to the model. Vendored builds,
 * source maps, lock files and similar are noise that bloats the prompt
 * and adds nothing for security review.
 */
const SKIP_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.git\//,
  /\.min\.(js|cjs|mjs)$/,
  /\.map$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
];

export function shouldSkipForAudit(path: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(path));
}

/**
 * Maximum total characters of code content to send to the model.
 * 50K chars ≈ 12K tokens — 4× cheaper than the prior 200K cap and
 * still enough to cover a typical small plugin's source surface area.
 */
export const MAX_CODE_CHARS = 50_000;

/**
 * System prompt instructing the model to act as a CMS plugin security auditor.
 *
 * We do NOT use response_format here — many Workers AI models (including
 * llama-3.2-3b-instruct) reject json_schema with "5025: This model doesn't
 * support JSON Schema". Instead we mandate JSON output via the prompt and
 * extract+parse it ourselves. This works with every text-generation model
 * on Workers AI, so model swaps don't break the audit pipeline.
 */
export const SYSTEM_PROMPT = `You are a security auditor for EmDash CMS plugins. Your job is to analyze plugin source code and identify security risks, privacy violations, and code quality issues.

CRITICAL OUTPUT FORMAT:
- Respond with ONE valid JSON object and NOTHING ELSE.
- Do NOT wrap the JSON in markdown code fences (no \`\`\`json).
- Do NOT include any prose, explanation, or commentary before or after.
- Do NOT include trailing commas or comments inside the JSON.
- Your entire response must parse with JSON.parse() on the first attempt.

The JSON object MUST have exactly these three top-level fields:
{
  "verdict": "pass" | "warn" | "fail",
  "riskScore": <integer 0-100>,
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "title": "<short>",
      "description": "<one to three sentences>",
      "category": "security" | "privacy" | "network" | "permissions" | "code-quality" | "compatibility",
      "location": "<file path or null>"
    }
  ]
}

Verdict definitions:
- "pass": safe to publish, no significant issues
- "warn": publishable with warnings, minor concerns
- "fail": should be rejected, critical or likely-malicious issues

Categories to consider:
- security: eval/Function usage, prototype pollution, injection, unsafe dynamic code
- privacy: accessing user data beyond declared scope, sensitive storage, tracking without consent
- network: exfiltration, requests to undeclared hosts, phone-home, hidden telemetry
- permissions: excessive capabilities, accessing APIs beyond manifest scope, privilege escalation
- code-quality: obfuscation, known malware patterns, suspicious minification
- compatibility: patterns that would break in the EmDash sandbox, unsupported APIs

Risk score guidelines:
- 0-20: clean code, no significant issues
- 21-50: minor concerns publishers should address
- 51-75: significant issues requiring attention
- 76-100: critical security problems, likely malicious

If the bundle is clean, return {"verdict":"pass","riskScore":0,"findings":[]}.`;

/**
 * Extract code files from a plugin bundle tarball (.tgz).
 * Reuses the modern-tar pattern from bundle-validator.ts.
 * Returns a Map of normalized file paths to their string content.
 */
export async function extractCodeFiles(
  tarballBytes: ArrayBuffer,
): Promise<Map<string, string>> {
  const codeFiles = new Map<string, string>();
  const decoder = new TextDecoder();
  const stream = new Blob([tarballBytes]).stream();
  const entries = await unpackTar(stream.pipeThrough(createGzipDecoder()));

  for (const entry of entries) {
    const name = entry.header.name.startsWith("./")
      ? entry.header.name.slice(2)
      : entry.header.name;

    // Skip directories
    if (entry.header.type === "directory" || name.endsWith("/")) continue;

    // Filter by code file extension
    const lastDot = name.lastIndexOf(".");
    const ext = lastDot >= 0 ? name.slice(lastDot) : "";
    if (!CODE_EXTENSIONS.has(ext)) continue;

    // Skip vendored / generated / lockfile noise
    if (shouldSkipForAudit(name)) continue;

    const data = entry.data ?? new Uint8Array(0);
    codeFiles.set(name, decoder.decode(data));
  }

  return codeFiles;
}

/**
 * Build the prompt content from extracted code files.
 *
 * Concatenates files with `--- file: {path} ---` headers.
 * Prioritizes manifest.json first, then alphabetical order.
 * Truncates at MAX_CODE_CHARS if total content exceeds the limit.
 */
export function buildPromptContent(codeFiles: Map<string, string>): string {
  // Sort files: manifest.json first, then alphabetical
  const sortedPaths = Array.from(codeFiles.keys()).sort((a, b) => {
    if (a === "manifest.json") return -1;
    if (b === "manifest.json") return 1;
    return a.localeCompare(b);
  });

  const parts: string[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const path of sortedPaths) {
    const content = codeFiles.get(path)!;
    const header = `--- file: ${path} ---\n`;
    const section = header + content + "\n\n";

    if (totalChars + section.length > MAX_CODE_CHARS) {
      // Include as much of this file as fits
      const remaining = MAX_CODE_CHARS - totalChars;
      if (remaining > header.length + 100) {
        parts.push(header + content.slice(0, remaining - header.length - 20) + "\n... [truncated]");
      }
      truncated = true;
      break;
    }

    parts.push(section);
    totalChars += section.length;
  }

  if (truncated) {
    console.log(
      `[audit] Truncated code content from ${Array.from(codeFiles.values()).reduce((sum, v) => sum + v.length, 0)} to ${MAX_CODE_CHARS} chars`,
    );
  }

  return parts.join("");
}

/**
 * Extract a JSON object from a free-form model response.
 *
 * Models often disobey "JSON only" instructions and return one of:
 *   1. Pure JSON: {...}
 *   2. JSON wrapped in markdown fences: ```json\n{...}\n```
 *   3. Prose preamble then JSON: "Here's the audit:\n{...}"
 *   4. JSON then trailing prose
 *
 * We try in this order:
 *   a) JSON.parse the whole response (the happy path)
 *   b) Strip markdown code fences and try again
 *   c) Find the first balanced { ... } block by scanning braces and try that
 *
 * Returns the parsed object on success, or null on failure.
 */
export function extractJsonFromResponse(text: string): unknown | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // 2. Strip ```json ... ``` or ``` ... ``` fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      /* fall through */
    }
  }

  // 3. Scan for the first balanced { ... } block
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
