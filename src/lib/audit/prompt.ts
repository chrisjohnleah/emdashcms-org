/**
 * AI audit prompt construction and code extraction.
 *
 * Builds the system prompt and user content for Workers AI code audits.
 * Extracts code files from plugin bundle tarballs using modern-tar.
 */
import { unpackTar, createGzipDecoder } from "modern-tar";

/**
 * Workers AI model used for code audits.
 *
 * llama-3.2-3b-instruct is small (3B params) but capable enough for the
 * lightweight static-leaning audit we run. It is roughly an order of
 * magnitude cheaper per token than the previous 26B gemma. Coupled with
 * the smaller MAX_CODE_CHARS / max_tokens caps below this gets the free
 * tier from ~14 audits/day to ~200+/day.
 */
export const MODEL_ID = "@cf/meta/llama-3.2-3b-instruct";

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
 * Returns structured JSON with verdict, risk score, and findings.
 */
export const SYSTEM_PROMPT = `You are a security auditor for EmDash CMS plugins. Your job is to analyze plugin source code and identify security risks, privacy violations, and code quality issues.

Analyze the provided code files and return a JSON assessment with:
- A verdict: "pass" (safe to publish), "warn" (publishable with warnings), or "fail" (should be rejected)
- A risk score from 0 (no risk) to 100 (maximum risk)
- An array of findings, each with severity, title, description, category, and optional location

Focus on these categories:
- security: Dangerous eval/Function usage, prototype pollution, injection vulnerabilities, unsafe dynamic code execution
- privacy: Accessing user data beyond declared scope, storing sensitive information, tracking users without consent
- network: Data exfiltration attempts, requests to unexpected external hosts, phone-home behavior, hidden telemetry
- permissions: Requesting excessive capabilities, accessing APIs beyond declared manifest scope, privilege escalation
- code-quality: Obfuscated code suggesting malicious intent, known malware patterns, suspicious minification
- compatibility: Patterns that would break in the EmDash sandbox environment, unsupported APIs

Scoring guidelines:
- 0-20: Clean code with no significant issues
- 21-50: Minor concerns that publishers should address
- 51-75: Significant issues requiring attention before use
- 76-100: Critical security problems, likely malicious

Return ONLY valid JSON matching the required schema. Do not include any text outside the JSON object.`;

/**
 * JSON schema for Workers AI response_format, constraining the model's output
 * to match the MarketplaceAuditDetail structure.
 */
export const AUDIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "warn", "fail"] },
    riskScore: { type: "integer", minimum: 0, maximum: 100 },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          title: { type: "string" },
          description: { type: "string" },
          category: {
            type: "string",
            enum: [
              "security",
              "privacy",
              "network",
              "permissions",
              "code-quality",
              "compatibility",
            ],
          },
          location: { type: "string" },
        },
        required: ["severity", "title", "description", "category"],
      },
    },
  },
  required: ["verdict", "riskScore", "findings"],
};

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
