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
  /**
   * Whether this model supports the Workers AI Async Batch API
   * (`queueRequest: true`). Batch-capable models avoid the 30-second
   * sync wall clock — we submit, ack the queue message, and a cron
   * poller picks up the result later. Only batch-capable models can
   * use heavy / slow architectures (70B+ dense, 120B+ MoE).
   *
   * Source: https://developers.cloudflare.com/workers-ai/models/?capabilities=Batch
   */
  batchCapable: boolean;
  /**
   * When true, the admin "Run AI" button for this model is rendered
   * disabled with `disabledReason` shown as a tooltip. Used for models
   * Cloudflare has published but not yet wired into the Async Batch
   * API — we keep them in the registry as a roadmap signal, and the
   * day Cloudflare enables batch we just flip this to false.
   */
  disabled?: boolean;
  disabledReason?: string;
}

export const AUDIT_MODELS: Record<AuditModelKey, AuditModelDef> = {
  // --- Tier 1: default for every upload (fast sync, best cost/quality) ---
  "glm-4.7-flash": {
    key: "glm-4.7-flash",
    workersAiId: "@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash",
    description:
      "Default. Z.AI GLM-4.7 Flash — speed-optimised 131K-ctx coding model with function calling. Strong real-world code reasoning, low hallucination, ~62 neurons/audit (161 audits/day on free tier).",
    estimatedNeurons: "~62",
    batchCapable: false,
  },

  // NOTE: batch-capable models (llama-3.3-70b-fast, qwen3-30b-a3b) were
  // previously registered here but have been removed. Cloudflare Workers
  // Free tier enforces a 10ms CPU budget on cron triggers, which our
  // batch polling loop can't reliably fit inside once D1 reads +
  // JSON.parse + writeback overhead is counted. The supporting
  // infrastructure (batch-poller.ts, consumer.ts batch branch, migration
  // 0022, `batchCapable` flag) is left in place as dormant code — a
  // future phase can re-enable batch via a queue-self-requeue pattern
  // (submit → requeue with delaySeconds → poll on next delivery) which
  // doesn't need a cron and runs inside the 15-minute queue consumer
  // wall clock. Until then, every production model runs sync inside the
  // audit queue consumer which gives us all the headroom we need for
  // plugins of realistic size.

  // --- Legacy: the original default, kept for regression testing ---
  "llama-3.2-3b": {
    key: "llama-3.2-3b",
    workersAiId: "@cf/meta/llama-3.2-3b-instruct",
    label: "Llama 3.2 3B (legacy)",
    description:
      "Legacy default. Small (3B params), fast and cheap (~17 neurons) but known to hallucinate security findings on anything more complex than trivial plugins. Kept available for regression testing; new audits should prefer GLM-4.7-Flash.",
    estimatedNeurons: "~17",
    batchCapable: false,
  },

  // --- Premium sync model running inside the queue consumer ---
  //
  // Queue consumers get a 15-minute wall-clock budget (not 30s — that's
  // the HTTP handler limit) and CPU time excludes I/O wait, so a
  // long-running `ai.run()` call against Gemma 4 26B is perfectly
  // valid inside the audit queue consumer. The earlier "timeouts" were
  // our wrangler.jsonc `limits.cpu_ms` default of 30s biting on larger
  // prompts; we've now bumped it to the 5-minute max, which gives
  // Gemma all the headroom it needs to reason over a typical plugin.
  //
  // Gemma stays non-batch because Cloudflare hasn't wired it into the
  // Async Batch API yet — but that only matters if we wanted to
  // defer processing across multiple Worker invocations. For a single
  // audit per queue message, sync-inside-consumer is the correct
  // pattern and this model is fully usable.
  "gemma-4-26b-a4b": {
    key: "gemma-4-26b-a4b",
    workersAiId: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B-A4B",
    description:
      "Premium. Google Gemma 4 26B MoE (4B active params), 256K ctx, strong reasoning and function calling. Runs sync inside the audit queue consumer (15-minute wall-clock budget, 5-minute CPU budget — AI inference wait doesn't count as CPU). Sharper findings on borderline plugins than GLM-4.7-Flash at the cost of ~100 neurons/audit.",
    estimatedNeurons: "~100",
    batchCapable: false,
  },
};

/**
 * Default model used when an audit job carries no modelOverride. Keep
 * this aligned with the best cost/quality tradeoff for sync audits so
 * the upload hot path doesn't burn through the daily neuron budget and
 * doesn't hallucinate findings on real plugins.
 */
export const DEFAULT_AUDIT_MODEL: AuditModelKey = "glm-4.7-flash";

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
export const SYSTEM_PROMPT = `You are a security auditor for EmDash CMS plugins. Your job is to analyze plugin source code and identify specific, evidence-backed security risks.

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
      "title": "<short, specific — name the actual pattern>",
      "description": "<one to three sentences, MUST quote or reference specific code>",
      "category": "security" | "privacy" | "network" | "permissions" | "code-quality" | "compatibility",
      "location": "<file path, with line hint if possible, or null>"
    }
  ]
}

DO NOT HALLUCINATE FINDINGS. Strict rules:
1. Every finding MUST cite a SPECIFIC line, function, or code pattern from the files provided. Generic statements like "may allow injection" without a concrete code reference are FORBIDDEN.
2. The \`emdash\` / \`@emdash-cms/*\` packages are the TRUSTED plugin runtime SDK and block/element builders. Using them is NEVER a risk. Do not flag \`definePlugin\`, \`PluginContext\`, \`ctx.kv\`, \`ctx.log\`, \`ctx.http\`, \`b.header\`, \`b.section\`, \`b.actions\`, \`e.button\` or any other SDK-provided primitive.
3. \`ctx.http.fetch\` and the \`network:fetch\` capability are the ONLY sanctioned way for plugins to make HTTP requests. Using them is CORRECT behaviour, not a risk — they are sandboxed by the host to the manifest's \`allowedHosts\`.
4. TypeScript files (.ts) passing typed data through \`URLSearchParams\`, typed API clients, or JSON.parse on typed responses are NOT injection vectors. Do not flag them.
5. If you cannot identify a concrete risky pattern supported by an actual code reference, return \`{"verdict":"pass","riskScore":0,"findings":[]}\`. "Pass" is the correct verdict for well-written code. Do not invent concerns to justify a non-empty findings list.
6. A single vague or speculative finding is worse than no findings. Better to miss a risk than fabricate one.

Real risks to look for (with concrete code evidence):
- security: \`eval()\`, \`new Function()\`, \`document.write()\`, \`innerHTML\` from user input, \`Object.assign({}, userInput)\` into prototypes, \`__proto__\` assignment, unsafe \`JSON.parse\` of untrusted strings used as code
- privacy: reading user data fields not declared in manifest, writing PII to KV/storage without consent, fingerprinting patterns
- network: \`fetch\`/\`XMLHttpRequest\` to hosts NOT listed in \`manifest.allowedHosts\`, WebSocket to unlisted hosts, DNS prefetch to attacker hosts, hidden \`Image.src\` pings
- permissions: calling APIs that require capabilities not in \`manifest.capabilities\`, privilege escalation attempts
- code-quality: obfuscated JS (minified bundle shipped as source, hex-encoded strings, \`\\x\` / \`\\u\` escaping of normal identifiers), typosquatting imports
- compatibility: use of \`window\`, \`document\`, Node-only modules, or other APIs not available in the EmDash sandbox

Verdict definitions (be strict about these):
- "pass": no findings OR only \`info\`-severity findings. Safe to publish.
- "warn": one or more \`low\` or \`medium\` findings. Publishable with caveats.
- "fail": at least one \`high\` or \`critical\` finding with a concrete code citation. Reject.

Risk score guidelines:
- 0-20: clean code, trust signals strong
- 21-50: minor non-blocking concerns
- 51-75: at least one high-severity finding with evidence
- 76-100: at least one critical finding with evidence; likely malicious or catastrophically broken

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
