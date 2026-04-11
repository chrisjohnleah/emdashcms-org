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
// Bench results (bench-results/2026-04-11T15-15-54-020Z.json, 6 models
// × 17 fixtures with the sandbox-aware prompt):
//
//   Model                 Adv TP  FP   Rel   Latency  Neurons  Notes
//   ─────────────────────────────────────────────────────────────────
//   mistral-small-3.1-24b 12/14   0/3  88%   5.2s     144      ★ default (handles serpdelta perfectly)
//   qwen2.5-coder-32b     11/14   0/3  82%   4.1s     260      code-specialist alt, fastest high-TP
//   glm-4.7-flash         11/14   0/2  94%   15.0s    92       reasoning alt (regressed on bigger prompt, fails on serpdelta)
//   gemma-4-26b-a4b       10/14   0/2  76%   19.6s    78       deep-scan (3x 3050 errors, fails on large plugins)
//   gpt-oss-20b            9/14   0/3  94%   6.4s     102      REMOVED — missed proto-pollution, RCE, data-harvesting
//   llama-4-scout-17b      8/14   0/3 100%   2.1s     109      REMOVED — fastest but misses real threats
//
// "Adv TP" = adversarial true positives (verdict=fail or warn with a
// concrete code citation). "FP" = false positives on clean fixtures.
// Parse failures were excluded from FP because they're transient
// infrastructure issues the queue consumer retries on.
//
// Mistral Small 3.1 24B wins on the metric that matters most: it
// catches the most real threats, never false-positives, handles large
// plugins that kill reasoning models, and it's fast. The 2 parse
// failures in its run are recoverable on retry in production.
export const AUDIT_MODELS: Record<AuditModelKey, AuditModelDef> = {
  // --- Default: empirically validated winner of the adversarial bench ---
  //
  // Mistral Small 3.1 24B. Dense 24B with first-class function
  // calling and Mistral's structured-output guarantees. Caught 12/14
  // adversarial fixtures including every in-sandbox abuse pattern
  // (quota-abuse, admin-phishing, data-harvesting, backdoor-config,
  // xss-public-route) on the sandbox-aware prompt. Critical
  // advantage over reasoning models: no chain-of-thought token
  // budget problem, so it completes cleanly on large plugins where
  // GLM-4.7-Flash and Gemma 4 token-exhaust (serpdelta 33KB: Mistral
  // finishes in 2.4s with verdict=pass, reasoning models both fail).
  "mistral-small-3.1-24b": {
    key: "mistral-small-3.1-24b",
    workersAiId: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    label: "Mistral Small 3.1 24B",
    description:
      "Default. Mistral Small 3.1 — 24B dense with function calling and Mistral's strongest structured-output guarantees. 128K ctx. Empirically validated at 12/14 (86%) true-positive rate on the adversarial fixture suite including RCE, exfiltration, cryptojacking, admin UI phishing, data harvesting, backdoor config flags, and stored XSS in public routes. Zero false positives. ~5.2s avg latency, ~144 neurons/audit. Handles large plugins reliably where reasoning models token-exhaust.",
    estimatedNeurons: "~144",
    batchCapable: false,
  },

  // --- Code specialist: Qwen2.5 Coder 32B ---
  //
  // Purpose-built for code understanding, explicitly trained on code
  // review tasks. Benchmarked at 11/14 (79%) adversarial TP + 0/3 FP
  // with the fastest latency of any high-TP model (4.1s avg). More
  // expensive than Mistral (~260 vs 144 neurons) but a solid second
  // opinion specifically for code-heavy plugins. Returns JSON as a
  // pre-parsed object via `result.response` — our extractor handles
  // both string and object forms.
  "qwen2.5-coder-32b": {
    key: "qwen2.5-coder-32b",
    workersAiId: "@cf/qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen2.5 Coder 32B",
    description:
      "Code specialist. Qwen2.5-Coder-32B is purpose-built for code understanding and review. 32K ctx (enough for ~10K-token plugin prompts). 11/14 (79%) adversarial TP + 0/3 FP on the bench, fastest high-TP model at ~4.1s avg. ~260 neurons/audit — costlier than the default but produces concise, focused findings with zero hallucinations.",
    estimatedNeurons: "~260",
    batchCapable: false,
  },

  // --- Reasoning alternative: GLM-4.7 Flash ---
  //
  // Kept as an admin-selectable second opinion for complex plugins
  // where reasoning might catch nuance the dense models miss. Still
  // usable but regressed when the sandbox-aware prompt was added —
  // ~79% TP on 14 adversarial fixtures (down from 89% on the smaller
  // earlier suite). Reasoning-model token exhaustion makes it
  // unreliable on large plugins like serpdelta (33KB → parse failure).
  "glm-4.7-flash": {
    key: "glm-4.7-flash",
    workersAiId: "@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash",
    description:
      "Reasoning alternative. Z.AI GLM-4.7 Flash — speed-optimised reasoning model, 131K ctx, function calling. ~11/14 (79%) adversarial TP, reliable on small-to-medium plugins but fails on large ones (reasoning content exhausts 4096 token budget). Keep for admin-triggered second opinions when the plugin is borderline.",
    estimatedNeurons: "~92",
    batchCapable: false,
  },

  // --- Deep scan: Gemma 4 26B-A4B ---
  //
  // Google Gemma 4 26B MoE — 4B active params, 256K ctx, strong
  // reasoning. Highest individual-finding detail when it works, but
  // bench showed ~24% unreliability (3x 3050 capacity errors + 1
  // serpdelta token exhaustion). Remains as a slow deep-scan option
  // for admin-triggered borderline reviews.
  "gemma-4-26b-a4b": {
    key: "gemma-4-26b-a4b",
    workersAiId: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B-A4B (deep scan)",
    description:
      "Deep scan. Google Gemma 4 26B MoE (4B active params), 256K ctx. 10/14 adversarial TP on the bench, zero false positives, but showed ~24% unreliability (3050 capacity errors and token-exhaustion on large plugins). Use as an admin-triggered deep review when Mistral or Qwen flag borderline cases.",
    estimatedNeurons: "~78",
    batchCapable: false,
  },

  // REMOVED from the registry after the 2026-04-11 sandbox-aware bench:
  //
  //   llama-4-scout-17b-16e-instruct   8/14 TP (57%) — rubber-stamped
  //                                    proto-pollution, RCE variants,
  //                                    data-harvesting, xss-public-route
  //                                    as "pass". Fastest in shortlist
  //                                    (2.1s) but speed is false
  //                                    economy when it misses real
  //                                    threats.
  //
  //   gpt-oss-20b                      9/14 TP (64%) — similar miss
  //                                    pattern to Llama 4 Scout. High
  //                                    hallucination rate per OpenAI's
  //                                    own model card (SimpleQA 0.914).
  //
  //   llama-3.2-3b-instruct            1/9 TP from an earlier round.
  //                                    3B params is too small for code
  //                                    review — do NOT re-add.
  //
  //   llama-3.3-70b-fast /
  //   qwen3-30b-a3b-fp8                Removed because they need the
  //                                    Workers AI Async Batch API which
  //                                    can't run under Workers Free
  //                                    tier's 10ms cron CPU budget.
  //                                    Infrastructure (batch-poller.ts,
  //                                    consumer.ts batch branch,
  //                                    migration 0022) is kept dormant.
};

/**
 * Default model used when an audit job carries no modelOverride.
 *
 * Mistral Small 3.1 24B won the 2026-04-11 sandbox-aware benchmark
 * (17 fixtures × 6 models) on the metric that matters most: true-
 * positive rate against adversarial plugins. See AUDIT_MODELS comment
 * above for the full scoreboard and bench-results/ for the raw dumps.
 */
export const DEFAULT_AUDIT_MODEL: AuditModelKey = "mistral-small-3.1-24b";

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
export const SYSTEM_PROMPT = `You are a security auditor for the EmDash CMS plugin marketplace. Your job is to decide whether this plugin can be safely installed on an end user's website without betraying their trust, harvesting their visitors' data, or burning their hosting quota.

## SANDBOX CONTEXT — READ BEFORE AUDITING

Every installed plugin runs inside its own Cloudflare Worker sandbox, per site, isolated from:
- other plugins on the same site
- other sites running the same plugin
- the host CMS internals, the host filesystem, and any shared state

The sandbox enforces the manifest at runtime: fetches to hosts NOT in \`manifest.allowedHosts\` are blocked, and API access without the matching \`manifest.capabilities\` entry is blocked. You do NOT need to catch sandbox escapes — Cloudflare does that. Your job is to catch threats that work WITHIN the declared permissions, where the sandbox cannot help.

This is closer to **browser extension review** than classic software supply-chain review. Assume the sandbox is strong. Assume the attacker's goal is to use legitimately-granted permissions for illegitimate purposes.

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
3. \`ctx.http.fetch\` to a host listed in \`manifest.allowedHosts\` is CORRECT behaviour, not a risk BY ITSELF. Look at WHAT is being sent, not just that a fetch exists.
4. \`URLSearchParams\`, typed API clients, bearer-token auth to a declared host, input validation, parseInt + isNaN guards, HTML-escaped error messages — these are defensive patterns, NOT vulnerabilities.
5. "Pass" is the correct verdict for well-written code. If you cannot point to a specific risky pattern with a code citation, return \`{"verdict":"pass","riskScore":0,"findings":[]}\`. Missing a real risk is better than fabricating one.

## PRIMARY THREATS (these WORK inside the sandbox — find them)

### Trust betrayal — using declared permissions for evil (critical, verdict=fail)
The plugin has a legitimate reason to call its declared host. It uses that legitimate channel to ship data the user never consented to share.
- \`ctx.kv.list\` or wildcard KV scans followed by sending the result into ANY fetch — even to a declared host. Example: "error reporter" that dumps the full KV snapshot (API tokens, subscriber lists, admin config) as "crash context".
- Newsletter / mailing-list plugins that sync the entire subscriber list + admin email to their declared platform host on every operation. That's a mailing-list harvest disguised as "keeping in sync".
- Request bodies containing \`api_key\`, \`token\`, \`secret\`, \`credential\`, \`session\`, \`password\`, \`admin_email\`, \`all_posts\`, \`all_users\`, \`subscribers\`, or similar wholesale keys.
- Any pattern where site-owner data beyond the plugin's stated purpose is sent to a third-party host — even if the host is declared.

### Quota / wallet abuse — burning the publisher's Cloudflare budget (critical, verdict=fail)
The sandbox doesn't stop a plugin from melting its own quota, but the publisher pays for it.
- Cryptojacking: tight loops performing repeated hash computations, nonce search, XOR mixing, \`Math.imul\` chains, or prefix-matching (\`hash.startsWith("000...")\`). Function names ("image processing", "cache warming", "deduplication") are often disguises.
- Request fan-out: for-loops that spawn 10+ concurrent \`fetch\` calls per iteration, or \`setInterval\` handlers that hit the network every few seconds. These amplify a small trigger into a quota-burning DoS.
- Infinite \`while (true)\` / recursive \`setTimeout\` chains with no backoff.
- Connections to \`pool.*\`, \`mine.*\`, \`*mining*\`, \`*miner*\`, \`stratum+*\`, \`wss://*cryptomine*\` hosts.

### UI social engineering — phishing via admin blocks (critical, verdict=fail)
The plugin renders blocks into the admin UI. It can display anything — including fake credential prompts.
- Admin UI blocks that ask for the site owner's password, OAuth token, admin credentials, API keys for other services, or any "re-authentication" prompt. The CMS handles real auth — a plugin prompting for passwords is always phishing.
- Form labels like "Session Expired", "Verify Admin", "Re-enter Password", "Confirm Identity", "Security Check" when the plugin isn't an authentication plugin.
- Random / time-gated prompts (\`if (Math.random() < 0.1)\`, \`if (Date.now() > ...)\`) that display credential forms intermittently to avoid detection.
- Plugin capturing user input via block forms and immediately ctx.kv.set + fetch — especially if the input field name suggests credentials.

### Public route safety — plugin-served content to site visitors (high, verdict=fail)
Plugins can declare \`public/*\` routes that serve responses to site visitors on the publisher's domain. XSS here compromises every visitor.
- String-concat HTML construction with user-supplied values in public route handlers: \`html += "<div>" + comment.body + "</div>"\` is stored XSS.
- Returning \`Content-Type: text/html\` with unescaped interpolation of KV-stored data.
- \`eval\` / \`new Function\` / \`innerHTML\` in a public route handler — same XSS impact.
- Public routes that redirect based on user-controlled query parameters without a host allowlist.

### Delayed / conditional backdoors (critical, verdict=fail)
The plugin fetches a remote config or feature-flag on install or daily cron. The behavior is benign at audit time. Six months later, the config flips and the plugin activates hidden functionality.
- \`await fetch(remoteConfigUrl)\` followed by \`if (config.diagnostic_mode)\`, \`if (config.enabled)\`, \`if (config.telemetry)\` gates that execute exfiltration, mass KV reads, or other sensitive operations.
- Any code path that unlocks new behavior based on remote state the reviewer can't see.
- Periodic polling of "config" / "flags" / "meta" endpoints that then route into privileged code paths.

### Remote code execution — always bad, even in sandbox (critical, verdict=fail)
In-sandbox RCE still lets the plugin run arbitrary code, which means anything the sandbox DOES grant (KV, allowed fetches, admin blocks) becomes available to the injected code. Always flag.
- \`eval(x)\` where \`x\` is not a compile-time string literal (including template strings with variables).
- \`new Function("param", x)\` where \`x\` is not a compile-time string literal.
- \`setTimeout(stringArg)\` / \`setInterval(stringArg)\` — string-form timers are eval.
- \`import(url)\` where \`url\` is anything but a compile-time literal. Dynamic import of a user-or-remote-controlled URL fetches and executes arbitrary remote code.
- \`document.write(userInput)\`, \`innerHTML = userInput\`.

### Obfuscation — intent signal regardless of sandbox (critical, verdict=fail)
No legitimate plugin author ships obfuscated code. Obfuscation is an admission of bad intent.
- Identifier names matching \`_0x[0-9a-f]+\`, \`_$[0-9a-z]+\`, or pure-hex identifier chains — javascript-obfuscator output.
- Long arrays of \`\\x[0-9a-f]{2}\` / \`\\u[0-9a-f]{4}\` hex-encoded strings followed by decoding loops (XOR, base64, String.fromCharCode chains).
- Ternary / comma operator chains with no whitespace and single-letter identifiers.

### Prototype pollution (high, verdict=fail)
Affects the plugin's own sandbox state but can subvert all its own logic. Still bad.
- \`Object.assign(target, userInput)\`, \`_.merge(target, userInput)\`, or custom recursive \`deepMerge\` functions that copy \`__proto__\`, \`constructor\`, or \`prototype\` keys without a deny-list.
- Direct assignment to \`obj.__proto__.x = ...\`.

## SECONDARY THREATS (sandbox de-risks these — flag as evidence of intent, not catastrophic)

- Fetch to a host NOT in \`manifest.allowedHosts\` — the sandbox blocks it at runtime, but the presence of the code is an intent signal. Flag as \`medium\` or \`high\` depending on what the fetch contains.
- Calling global \`fetch()\` instead of \`ctx.http.fetch()\` — sandbox treats both the same, but the intent to bypass the SDK is a red flag. Flag as \`medium\`.
- Use of \`document\`, \`window\`, \`fs\`, \`child_process\`, \`process.env\` — sandbox blocks these at runtime. Flag as \`low\`/\`medium\` (broken code or naive port, not always malicious).
- Capability declared in manifest but code doesn't use it — harmless, flag as \`info\` at most.

## VERDICT RULES

- **pass**: no findings, OR only \`info\`-severity findings. Safe to publish. Correct verdict for well-written code — do not invent concerns.
- **warn**: one or more \`low\` or \`medium\` findings, no \`high\` or \`critical\`. Publishable with caveats.
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
