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

// Model registry — empirically ranked by bench-results/2026-04-11 runs
// against the bench-fixtures/ adversarial suite (9 adversarial + 3 clean
// fixtures: eval-attack, exfiltration, proto-pollution, obfuscated,
// credential-leak, capability-overreach, cryptominer, rce-function-
// constructor, dynamic-import-rce, clean-seo-plugin, clean-api-client,
// serpdelta-0.2.4).
//
// Final scoreboard:
//   glm-4.7-flash:   8/9 TP, 0/3 FP, 100% reliable, ~16s, ~93 neurons
//   gemma-4-26b:     6/9 TP, 0/3 FP,  75% reliable (3050 + empty
//                    response failures on reasoning model), ~25s, ~82n
//   llama-3.2-3b:    1/9 TP, 0/3 FP but 1 hallucinated finding —
//                    DISQUALIFIED, rubber-stamps clean verdicts without
//                    actually reading the code
//
// GLM-4.7-Flash wins on every meaningful axis:
//   - Highest true-positive rate (89% vs Gemma's 67% completed)
//   - Perfect reliability (12/12 successful runs vs Gemma's 9/12)
//   - Fastest latency (16s avg vs Gemma's 25-63s)
//   - Competitive cost (~93 vs ~82 neurons — 13% more for 22% better
//     TP rate and 33% better reliability)
//   - Zero false positives across all 3 clean fixtures
//
// The one miss — `credential-leak` — is a subtle "legitimate error
// reporting that happens to dump your KV to a declared host" case.
// Both GLM and Gemma struggled with it; the system prompt now names
// the bulk-KV-exfiltration pattern explicitly to reduce future misses.
export const AUDIT_MODELS: Record<AuditModelKey, AuditModelDef> = {
  // --- Default: empirically validated winner of the adversarial bench ---
  "glm-4.7-flash": {
    key: "glm-4.7-flash",
    workersAiId: "@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash",
    description:
      "Default. Z.AI GLM-4.7 Flash — speed-optimised reasoning model with function calling and 131K ctx. Validated at 8/9 true-positive rate on our adversarial fixture suite (eval, exfiltration, prototype pollution, obfuscation, cryptominers, Function-constructor RCE, dynamic import RCE, capability overreach) and 0/3 false-positive rate on clean plugins. 100% reliability across 12 benchmark runs. ~93 neurons/audit, ~16s latency.",
    estimatedNeurons: "~93",
    batchCapable: false,
  },

  // --- Second-opinion: deeper reasoning but less reliable ---
  //
  // Gemma 4 26B-A4B runs sync inside the audit queue consumer (we have
  // a 15-minute wall-clock budget and AI inference wait doesn't count
  // as CPU, so long inferences are fine in principle). It's included
  // as an admin-selectable second opinion rather than the default
  // because the bench surfaced two reliability issues that disqualify
  // it from the hot path:
  //
  //   1. Workers AI 3050 ("Max retries exhausted") capacity errors
  //      hit ~20% of requests in our test runs. Gemma 4 is still
  //      newly launched (2026-04-04) and capacity is tight.
  //   2. On some prompts Gemma burned the full max_tokens=4096
  //      completion budget on `reasoning_content` and left
  //      `content` empty — producing no parseable verdict after
  //      60+ seconds of inference. max_tokens=8192 might help but
  //      would further increase cost and latency.
  //
  // GLM-4.7-Flash has the same reasoning architecture but completes
  // reliably in our tests, so it's the sensible default. Keep Gemma
  // here for the cases where an admin wants a slower, bigger-model
  // second opinion on a borderline plugin.
  "gemma-4-26b-a4b": {
    key: "gemma-4-26b-a4b",
    workersAiId: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B-A4B (deep scan)",
    description:
      "Deep scan. Google Gemma 4 26B MoE (4B active params), 256K ctx. Caught credential-leak where GLM-4.7-Flash missed it, but showed ~25% unreliability (3050 capacity errors + empty-response token exhaustion) on our bench, so it's an admin-selectable second opinion rather than a default. ~25-40s latency, ~82 neurons/audit.",
    estimatedNeurons: "~82",
    batchCapable: false,
  },

  // NOTE: llama-3.2-3b-instruct was removed from the registry on
  // 2026-04-11 after adversarial benchmarking showed it caught only
  // 1/9 real threats (11% TP rate) while hallucinating findings on
  // clean plugins. Its output was typically 25 tokens — just enough
  // to rubber-stamp `{"verdict":"pass","riskScore":0,"findings":[]}`
  // without actually reviewing the code. Keeping it as an option gave
  // admins a false sense of security: "I ran the AI audit" when the
  // AI audit never meaningfully ran. See bench-results/ for the raw
  // evidence. Do NOT re-add without fresh bench validation against
  // the full adversarial fixture suite.
  //
  // Similarly, batch-capable models (llama-3.3-70b-fast, qwen3-30b-a3b)
  // were removed because Workers Free tier's 10ms CPU budget on cron
  // triggers breaks our batch polling loop. Supporting infrastructure
  // (batch-poller.ts, consumer.ts batch branch, migration 0022,
  // `batchCapable` flag) is left as dormant code — a future phase can
  // re-enable via queue-self-requeue pattern that doesn't need a cron.
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
export const SYSTEM_PROMPT = `You are a security auditor for the EmDash CMS plugin marketplace. Your ONLY job is to decide whether this plugin can be safely installed by end users who will run it on their websites. You are the last line of defence before it ships.

## OUTPUT RULES (non-negotiable)

1. Respond with ONE valid JSON object and NOTHING ELSE. No markdown code fences, no prose, no preamble, no trailing commentary.
2. Your entire response must parse with JSON.parse() on the first attempt.
3. Be terse in your reasoning. Emit the JSON as quickly as possible. If you are a reasoning model, keep internal reasoning concise — long chains of thought waste the output budget and leave the JSON truncated.

## REQUIRED SCHEMA

{
  "verdict": "pass" | "warn" | "fail",
  "riskScore": <integer 0-100>,
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "title": "<short, specific — name the actual pattern>",
      "description": "<one to three sentences, MUST quote or reference a specific line, function, or literal from the code>",
      "category": "security" | "privacy" | "network" | "permissions" | "code-quality" | "compatibility",
      "location": "<file path, with line hint if possible, or null>"
    }
  ]
}

## ANTI-HALLUCINATION RULES

1. Every finding MUST cite a SPECIFIC line, function, or literal from the files provided. Generic "may allow injection" findings without code evidence are FORBIDDEN.
2. The \`emdash\` and \`@emdash-cms/*\` packages are the TRUSTED plugin SDK. NEVER flag \`definePlugin\`, \`PluginContext\`, \`ctx.kv\`, \`ctx.log\`, \`ctx.http\`, \`b.header\`, \`b.section\`, \`b.actions\`, \`b.form\`, \`e.button\`, \`e.input\`, \`validateBlocks\`, or any other SDK primitive as a risk.
3. \`ctx.http.fetch\` and the \`network:fetch\` capability are the ONLY sanctioned way for plugins to make HTTP requests. Using them to call a host listed in \`manifest.allowedHosts\` is CORRECT behaviour, not a risk.
4. \`URLSearchParams\`, typed API clients, bearer-token auth, Zod validation, parseInt with isNaN guards, HTML-escaping error summaries — these are defensive patterns, NOT vulnerabilities.
5. "Pass" is the correct verdict for well-written code. If you cannot point to a specific risky pattern with a code citation, return \`{"verdict":"pass","riskScore":0,"findings":[]}\`. Missing a real risk is better than fabricating one.

## CONCRETE THREATS TO CATCH

These are the patterns that ACTUALLY let malicious plugins through. When you see any of them in the provided code, you MUST flag them with a specific citation.

### Remote code execution (always critical, verdict=fail)
- \`eval(...)\` with ANY argument that isn't a compile-time string literal, including template strings containing variables. Example: \`eval(\\\`(function(x){return \${expr}})\\\`)\` is RCE.
- \`new Function(...)\` with non-literal arguments. Example: \`new Function("post", userExpression)\` compiles arbitrary attacker code.
- \`setTimeout(stringArg, ...)\` or \`setInterval(stringArg, ...)\` — string-form timers are \`eval\` in disguise.
- \`import(url)\` where \`url\` is anything but a compile-time string literal. Dynamic import of a user-controlled or remote URL fetches and executes arbitrary remote code.
- \`document.write(userInput)\` or \`innerHTML = userInput\`.

### Data exfiltration (critical, verdict=fail)
- \`fetch()\` / \`XMLHttpRequest\` / \`WebSocket\` to a host NOT present in \`manifest.allowedHosts\`. Even if the fetch is wrapped in try/catch or "optional", a single unlisted-host call is exfiltration.
- Calling global \`fetch\` directly INSTEAD of \`ctx.http.fetch\`. Global \`fetch\` bypasses the sandbox and is ALWAYS a red flag regardless of whether the host is declared.
- \`ctx.kv.list\` followed by passing ALL keys/values into \`fetch\` (even to a declared host). Example: "error reporter" that sends the full KV snapshot as crash context — this dumps the publisher's API tokens, subscriber lists, and private config. Flag as high/critical credential leak.
- Stringified JSON body containing \`api_key\`, \`token\`, \`secret\`, \`credential\`, \`session\`, \`password\`, \`all_posts\`, \`all_users\`, or similar wholesale-data keys.

### Cryptojacking / resource abuse (critical, verdict=fail)
- Tight loops (\`while\`, \`for\`) running indefinitely or via \`setInterval\`, especially ones performing repeated hash computations, nonce search, XOR mixing, \`Math.imul\` chains, or prefix-matching (\`hash.startsWith("000...")\`). These are proof-of-work / mining patterns regardless of how the function is named ("image processing", "deduplication", "cache warming" are common disguises).
- Any connection to \`pool.*\`, \`mine.*\`, \`*mining*\`, \`*miner*\`, \`stratum+*\`, \`wss://*cryptomine*\`.

### Obfuscation / packed code (critical, verdict=fail)
- Variable or function names matching \`_0x[0-9a-f]+\`, \`_$[0-9a-z]+\`, or pure-hex identifier chains — these are JavaScript obfuscator output (javascript-obfuscator, obfuscator.io).
- Long arrays of \`\\x[0-9a-f]{2}\` or \`\\u[0-9a-f]{4}\` hex-encoded strings followed by decoding loops (XOR, base64, String.fromCharCode chains). The fact that the strings are hidden is the attack — always flag as critical, always assume malicious intent.
- Ternary/comma operator chains with no whitespace and 1-letter identifiers — obfuscated code is UNREADABLE to humans, which is the point.

### Prototype pollution (high, verdict=fail)
- \`Object.assign(target, userInput)\`, \`_.merge(target, userInput)\`, or custom recursive merge functions that copy \`__proto__\`, \`constructor\`, or \`prototype\` keys without an explicit deny-list. Example: \`deepMerge(DEFAULTS, JSON.parse(req.body))\` where \`req.body\` can reach \`__proto__\` → application-wide pollution.
- Direct assignment to \`obj.__proto__.x = ...\`.

### Permission / capability overreach (high, verdict=fail)
- Calling an API that requires a capability not listed in \`manifest.capabilities\`. If the code uses \`fetch\` but the manifest declares \`"capabilities": []\`, that's overreach. If it touches \`ctx.http\` without \`network:fetch\`, that's overreach.
- Fetching hosts that aren't in \`manifest.allowedHosts\`.
- Plugins declaring zero capabilities but using global browser/Node APIs (\`document\`, \`window\`, \`fs\`, \`child_process\`, \`process.env\`) — these are also overreach attempts.

## VERDICT RULES

- **pass**: no findings, OR only \`info\`-severity findings. Safe to publish. This is the correct verdict for well-written code — do not invent concerns.
- **warn**: one or more \`low\` or \`medium\` findings. Publishable with caveats.
- **fail**: at least ONE \`high\` or \`critical\` finding with a concrete code citation. Reject.

## RISK SCORE

- 0-20: clean, trustworthy code
- 21-50: minor non-blocking concerns
- 51-75: at least one high-severity finding with evidence
- 76-100: critical finding with evidence; likely malicious or catastrophically broken

If the bundle is clean, return \`{"verdict":"pass","riskScore":0,"findings":[]}\`. Emit the JSON immediately. Do not narrate.`;

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
