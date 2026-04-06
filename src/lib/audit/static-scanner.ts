/**
 * Static heuristic scanner for plugin bundles.
 *
 * Runs on every upload regardless of AUDIT_MODE — costs zero neurons,
 * is deterministic, and catches the obvious 80%: dangerous primitives,
 * obfuscation hints, and capability/host mismatches between the manifest
 * and the actual code surface.
 *
 * Findings are classified into two tiers:
 *
 *   - BLOCKING: hard reject. Used by `static-first` audit mode to refuse
 *     publication outright. Reserved for patterns with no legitimate use
 *     in the Cloudflare Workers-style runtime EmDash plugins target.
 *
 *   - NON-BLOCKING (flagging): published with a Caution badge. Used for
 *     suspicious-but-possibly-legitimate patterns — e.g. bundled CJS
 *     `require()` calls, `fs` references from dead dependency code,
 *     undeclared network hosts, broad capabilities.
 *
 * The scanner is pure: input is a Map of file path to text content plus
 * a validated manifest. No I/O, no DB access, no async. Keeps it trivially
 * unit-testable and reusable in the local audit harness.
 *
 * Ruleset is public — see /docs/security for the end-user documentation,
 * or read this file directly. Security through documented expectations,
 * not obscurity.
 */

import type { ValidatedManifest } from "../publishing/manifest-schema";

export type StaticFindingSeverity = "info" | "low" | "medium" | "high";

export interface StaticFinding {
  severity: StaticFindingSeverity;
  category: "security" | "permissions" | "network" | "code-quality";
  title: string;
  description: string;
  location?: string;
  /**
   * True when the finding represents a hard rejection signal. Soft
   * (non-blocking) findings still appear in the findings list but do
   * not cause `static-first` mode to reject the version.
   */
  blocking: boolean;
}

export interface StaticScanResult {
  findings: StaticFinding[];
  /** Number of distinct dangerous-primitive matches across all files */
  dangerousPrimitiveCount: number;
  /** Number of findings flagged as blocking (hard-reject signals) */
  blockingCount: number;
  /** Hosts referenced in code that aren't declared in manifest.allowedHosts */
  undeclaredHosts: string[];
}

interface DangerousPattern {
  pattern: RegExp;
  title: string;
  severity: StaticFindingSeverity;
  blocking: boolean;
  description: string;
}

/**
 * Patterns we consider dangerous in untrusted plugin code.
 *
 * EmDash plugins run in a Cloudflare-Workers-style runtime. Anything that
 * assumes Node.js built-ins (`child_process`, `fs`, `process.binding`) or
 * browser-only APIs (IndexedDB, localStorage) is suspicious — either it's
 * dead code from a misbundled dependency, or it's intentional and belongs
 * in a different runtime.
 *
 * Note on `.test()` with global-flag regexes: `RegExp.prototype.test` with
 * a `/g` pattern advances `lastIndex` between calls, which can cause every
 * other match to be missed. We only call `.test()` once per pattern per
 * file, so we're safe, but anyone adding match-counting here must either
 * drop the `g` flag or reset `lastIndex` before each call.
 */
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // --- BLOCKING: arbitrary code execution --------------------------------
  {
    pattern: /\beval\s*\(/,
    title: "Use of eval()",
    severity: "high",
    blocking: true,
    description:
      "eval() enables arbitrary runtime code execution and has no legitimate use in a CMS plugin. The version was rejected.",
  },
  {
    pattern: /\bnew\s+Function\s*\(/,
    title: "Use of new Function() constructor",
    severity: "high",
    blocking: true,
    description:
      "new Function() is equivalent to eval() — it constructs a function from a string at runtime. Bypasses any static analysis of the plugin and is not permitted.",
  },
  {
    pattern: /new\s+Worker\s*\(\s*URL\.createObjectURL/,
    title: "Worker constructed from a Blob URL",
    severity: "high",
    blocking: true,
    description:
      "Creating a Worker from URL.createObjectURL() is a common obfuscation vector for executing code whose source cannot be audited. Not permitted.",
  },
  // --- BLOCKING: Node.js internals not available in Workers --------------
  {
    // `child_process` almost never appears in legitimate browser/Worker code
    pattern: /\bchild_process\b/,
    title: "Reference to Node.js child_process module",
    severity: "high",
    blocking: true,
    description:
      "child_process is a Node.js-only module and is not available in the plugin runtime. Its presence signals Node-targeted code was bundled, likely with intent to escalate privileges in a different deployment.",
  },
  {
    pattern: /\bprocess\s*\.\s*binding\b/,
    title: "Access to internal Node.js native bindings",
    severity: "high",
    blocking: true,
    description:
      "process.binding exposes native addons and is intentionally unavailable in the plugin runtime. Never needed by legitimate plugins.",
  },

  // --- NON-BLOCKING: suspicious but possibly legitimate -----------------
  {
    // Only matches string-literal require calls. CJS shims produced by
    // bundlers often use `require(dynamicVar)` forms; we don't want to
    // fire on those because they're essentially always benign wrappers.
    pattern: /\brequire\s*\(\s*['"`]/,
    title: "CommonJS require() with string literal",
    severity: "low",
    blocking: false,
    description:
      "require() with a literal module name often appears in bundled CJS dependencies and is usually harmless. Flagged for review so a moderator or installer can confirm the dependency is expected.",
  },
  {
    // Tight match to specific fs method names — avoids false-positives
    // on variables named `refs`, `defs`, etc.
    pattern:
      /\bfs\s*\.\s*(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|readdir|readdirSync|unlink|unlinkSync|createReadStream|createWriteStream|existsSync|promises|rmSync|rm)\b/,
    title: "Reference to Node.js fs filesystem API",
    severity: "medium",
    blocking: false,
    description:
      "The plugin runtime has no filesystem. fs calls are either dead code from a bundled dependency or a sign the plugin was built for a different runtime. Review the file reference for intent.",
  },
  {
    // Dynamic import where the argument is NOT a string literal. Literal
    // forms like `import('./module.js')` are perfectly fine; computed
    // forms like `import(encodedUrl)` can hide what's being loaded.
    pattern: /\bimport\s*\(\s*(?!['"`])/,
    title: "Dynamic import with computed specifier",
    severity: "low",
    blocking: false,
    description:
      "Dynamic import() with a non-literal argument can load code whose source is decided at runtime. Flagged for review.",
  },
  {
    pattern: /\bIndexedDB\b/,
    title: "Reference to IndexedDB browser API",
    severity: "low",
    blocking: false,
    description:
      "IndexedDB is a browser-only storage API and is not available in the plugin runtime. Usually indicates the plugin was built for a browser context.",
  },
  {
    pattern: /\blocalStorage\b/,
    title: "Reference to localStorage browser API",
    severity: "low",
    blocking: false,
    description:
      "localStorage is a browser-only API and is not available in the plugin runtime. Usually indicates the plugin was built for a browser context.",
  },
  {
    pattern: /\bsessionStorage\b/,
    title: "Reference to sessionStorage browser API",
    severity: "low",
    blocking: false,
    description:
      "sessionStorage is a browser-only API and is not available in the plugin runtime. Usually indicates the plugin was built for a browser context.",
  },
  {
    // Long base64 literal — signals obfuscation
    pattern: /["'`][A-Za-z0-9+/=]{200,}["'`]/,
    title: "Long base64-like literal",
    severity: "low",
    blocking: false,
    description:
      "A string literal of 200+ base64 characters is a common way to smuggle executable payloads past naive scanners. Review the content and the code that decodes it.",
  },
  {
    // Hex-escape only string (>= 30 chars) — strong obfuscation hint
    pattern: /(?:\\x[0-9a-fA-F]{2}){30,}/,
    title: "Hex-escaped string sequence",
    severity: "medium",
    blocking: false,
    description:
      "30+ consecutive \\xNN hex escapes indicates deliberate string obfuscation. Legitimate code rarely uses this encoding at this length.",
  },
];

/** Match `https://host.example.com/...` style hostnames in code/strings. */
const HOST_PATTERN = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;

/**
 * Skip image, font, binary, and large minified files when scanning.
 * The scanner targets human-readable plugin source.
 */
const SCANNABLE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".md",
]);

/**
 * File extensions excluded from the dangerous-pattern scan (but still
 * checked for host references). Markdown frequently contains code
 * examples that mention `eval()` or similar as explanatory text — firing
 * on those would create painful false positives in READMEs.
 */
const SKIP_DANGEROUS_PATTERNS_EXTENSIONS = new Set([".md"]);

function isScannable(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return false;
  return SCANNABLE_EXTENSIONS.has(path.slice(lastDot));
}

function shouldSkipDangerousPatterns(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return false;
  return SKIP_DANGEROUS_PATTERNS_EXTENSIONS.has(path.slice(lastDot));
}

/**
 * Strip a leading subdomain so `oauth2.googleapis.com` and
 * `googleapis.com` both match a manifest entry of `googleapis.com`.
 * Also strips a leading wildcard from manifest entries (`*.example.com`).
 */
function normaliseHost(host: string): string {
  return host.replace(/^\*\./, "").toLowerCase();
}

function hostMatches(allowed: string[], host: string): boolean {
  const normHost = normaliseHost(host);
  for (const entry of allowed) {
    const norm = normaliseHost(entry);
    if (normHost === norm) return true;
    if (normHost.endsWith("." + norm)) return true;
  }
  return false;
}

/**
 * Run the static scanner across the bundle's source files.
 *
 * @param files       Map of file path → text content
 * @param manifest    Parsed plugin manifest (used for capability/host
 *                    cross-checks)
 */
export function runStaticScan(
  files: Map<string, string>,
  manifest: ValidatedManifest,
): StaticScanResult {
  const findings: StaticFinding[] = [];
  let dangerousPrimitiveCount = 0;
  const referencedHosts = new Set<string>();

  for (const [path, content] of files) {
    if (!isScannable(path)) continue;
    if (path === "manifest.json") continue;

    // Dangerous primitive patterns — skipped for documentation files so
    // a README explaining what `eval()` does doesn't get rejected.
    if (!shouldSkipDangerousPatterns(path)) {
      for (const rule of DANGEROUS_PATTERNS) {
        if (rule.pattern.test(content)) {
          dangerousPrimitiveCount++;
          findings.push({
            severity: rule.severity,
            category: "security",
            title: rule.title,
            description: `${rule.description} (Detected in ${path}.)`,
            location: path,
            blocking: rule.blocking,
          });
        }
      }
    }

    // Collect every external host referenced in code/strings.
    // Runs on all scannable file types including .md so README-declared
    // phone-home URLs don't slip past the declared-hosts check.
    HOST_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HOST_PATTERN.exec(content)) !== null) {
      const host = match[1].toLowerCase();
      // Skip bare TLDs and trivially short matches
      if (host.length < 4) continue;
      referencedHosts.add(host);
    }
  }

  // Cross-check declared vs referenced hosts
  const declared = manifest.allowedHosts ?? [];
  const undeclaredHosts: string[] = [];
  for (const host of referencedHosts) {
    if (!hostMatches(declared, host)) {
      undeclaredHosts.push(host);
    }
  }
  if (undeclaredHosts.length > 0) {
    findings.push({
      severity: "medium",
      category: "network",
      title: "Hosts referenced in code but not declared in manifest.allowedHosts",
      description: `Found ${undeclaredHosts.length} host(s) referenced in code that aren't in manifest.allowedHosts: ${undeclaredHosts.slice(0, 8).join(", ")}${undeclaredHosts.length > 8 ? ", …" : ""}. EmDash sandboxes outbound network calls — undeclared hosts will fail at runtime, or worse, signal data exfiltration if this is intentional.`,
      blocking: false,
    });
  }

  // Capability surface check
  if (manifest.capabilities.includes("network:fetch:any")) {
    findings.push({
      severity: "medium",
      category: "permissions",
      title: "Plugin requests unrestricted network access",
      description:
        "network:fetch:any bypasses the allowedHosts whitelist entirely. Plugins should prefer network:fetch with an explicit allowlist where possible.",
      blocking: false,
    });
  }
  if (manifest.capabilities.includes("read:users")) {
    findings.push({
      severity: "medium",
      category: "permissions",
      title: "Plugin reads user data",
      description:
        "read:users grants access to the user table. Verify the plugin only reads what it strictly needs and never transmits PII off-host.",
      blocking: false,
    });
  }
  if (manifest.capabilities.includes("email:intercept")) {
    findings.push({
      severity: "medium",
      category: "permissions",
      title: "Plugin intercepts outbound email",
      description:
        "email:intercept lets the plugin observe or modify every email leaving the CMS. Ensure the plugin's purpose justifies this scope.",
      blocking: false,
    });
  }

  const blockingCount = findings.reduce(
    (acc, f) => (f.blocking ? acc + 1 : acc),
    0,
  );

  return {
    findings,
    dangerousPrimitiveCount,
    blockingCount,
    undeclaredHosts,
  };
}
