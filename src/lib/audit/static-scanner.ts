/**
 * Static heuristic scanner for plugin bundles.
 *
 * Runs on every upload regardless of AUDIT_MODE — costs zero neurons,
 * is deterministic, and catches the obvious 80%: dangerous primitives,
 * obfuscation hints, and capability/host mismatches between the manifest
 * and the actual code surface.
 *
 * The scanner is intentionally conservative. It surfaces signals; it
 * does not pass/fail a publish on its own. The admin moderation queue
 * (or, in `auto` mode, the AI) makes the final call.
 */

import type { ValidatedManifest } from "../publishing/manifest-schema";

export type StaticFindingSeverity = "info" | "low" | "medium" | "high";

export interface StaticFinding {
  severity: StaticFindingSeverity;
  category: "security" | "permissions" | "network" | "code-quality";
  title: string;
  description: string;
  location?: string;
}

export interface StaticScanResult {
  findings: StaticFinding[];
  /** Number of distinct dangerous-primitive matches across all files */
  dangerousPrimitiveCount: number;
  /** Hosts referenced in code that aren't declared in manifest.allowedHosts */
  undeclaredHosts: string[];
}

/**
 * Patterns we consider dangerous in untrusted plugin code.
 *
 * `eval` and `new Function` allow arbitrary runtime code execution and
 * are virtually never needed in a well-scoped CMS plugin. Their presence
 * is a strong moderation signal even if not necessarily malicious.
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; title: string; severity: StaticFindingSeverity }[] =
  [
    {
      pattern: /\beval\s*\(/,
      title: "Use of eval()",
      severity: "high",
    },
    {
      pattern: /\bnew\s+Function\s*\(/,
      title: "Use of new Function() constructor",
      severity: "high",
    },
    {
      // Worker creation from a string blob — common obfuscation vector
      pattern: /new\s+Worker\s*\(\s*URL\.createObjectURL/,
      title: "Worker constructed from a Blob URL",
      severity: "medium",
    },
    {
      // Long base64 literal — signals obfuscation
      pattern: /["'`][A-Za-z0-9+/=]{200,}["'`]/,
      title: "Long base64-like literal",
      severity: "low",
    },
    {
      // Hex-escape only string (>= 60 chars) — strong obfuscation hint
      pattern: /(?:\\x[0-9a-fA-F]{2}){30,}/,
      title: "Hex-escaped string sequence",
      severity: "medium",
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

function isScannable(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return false;
  return SCANNABLE_EXTENSIONS.has(path.slice(lastDot));
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

    // Dangerous primitive patterns
    for (const { pattern, title, severity } of DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        dangerousPrimitiveCount++;
        findings.push({
          severity,
          category: "security",
          title,
          description: `Detected in ${path}. Review the surrounding code carefully — this primitive enables arbitrary execution and should be justified.`,
          location: path,
        });
      }
    }

    // Collect every external host referenced in code/strings
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
    });
  }
  if (manifest.capabilities.includes("read:users")) {
    findings.push({
      severity: "medium",
      category: "permissions",
      title: "Plugin reads user data",
      description:
        "read:users grants access to the user table. Verify the plugin only reads what it strictly needs and never transmits PII off-host.",
    });
  }
  if (manifest.capabilities.includes("email:intercept")) {
    findings.push({
      severity: "medium",
      category: "permissions",
      title: "Plugin intercepts outbound email",
      description:
        "email:intercept lets the plugin observe or modify every email leaving the CMS. Ensure the plugin's purpose justifies this scope.",
    });
  }

  return {
    findings,
    dangerousPrimitiveCount,
    undeclaredHosts,
  };
}
