/**
 * Local audit harness — fast feedback loop for the audit pipeline.
 *
 * Runs the same extraction + static scan code that ships in the Worker
 * against a .tgz bundle on disk. No D1, no R2, no Workers AI, no deploy.
 *
 * Usage:
 *   node scripts/audit-local.ts <path-to-bundle.tgz>
 *   node scripts/audit-local.ts ./fixtures/serpdelta-0.1.0.tgz
 *
 * Optional flags:
 *   --json   Print machine-readable JSON output
 *   --ai     (TODO) Also call the real Workers AI model via REST API
 *
 * What it checks:
 *   1. Bundle is a valid .tgz with safe paths
 *   2. manifest.json is present and validates against the schema
 *      (manifest-schema.ts — same one the Worker uses)
 *   3. Static scanner findings (eval/Function/obfuscation/undeclared hosts/
 *      sensitive capability warnings)
 *
 * Why this exists:
 *   The Worker test suite mocks Workers AI, so model API changes don't get
 *   caught by `npm test`. This harness lets you iterate on extraction,
 *   manifest validation, and static scan logic without a deploy roundtrip.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateBundle } from "../src/lib/publishing/bundle-validator.ts";
import { runStaticScan } from "../src/lib/audit/static-scanner.ts";
import { extractCodeFiles, buildPromptContent } from "../src/lib/audit/prompt.ts";

interface CliArgs {
  bundlePath: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let bundlePath = "";
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    } else if (!bundlePath) {
      bundlePath = arg;
    }
  }
  if (!bundlePath) {
    console.error(
      "Usage: node scripts/audit-local.ts <path-to-bundle.tgz> [--json]",
    );
    process.exit(2);
  }
  return { bundlePath: resolve(bundlePath), json };
}

function colour(code: string, text: string): string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const dim = (s: string) => colour("2", s);
const red = (s: string) => colour("31", s);
const yellow = (s: string) => colour("33", s);
const green = (s: string) => colour("32", s);
const cyan = (s: string) => colour("36", s);
const bold = (s: string) => colour("1", s);

function severityColour(sev: string): (s: string) => string {
  switch (sev) {
    case "high":
    case "critical":
      return red;
    case "medium":
      return yellow;
    case "low":
    case "info":
    default:
      return dim;
  }
}

async function main() {
  const { bundlePath, json } = parseArgs(process.argv);

  if (!json) console.log(dim(`Reading ${bundlePath}…`));

  let buf: Buffer;
  try {
    buf = await readFile(bundlePath);
  } catch (err) {
    console.error(red(`Failed to read bundle: ${(err as Error).message}`));
    process.exit(1);
  }

  // We don't know the plugin id ahead of time, so use a placeholder and
  // ignore the supply-chain mismatch error from validateBundle. We just
  // want the manifest extraction.
  const tarballBytes = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;

  // First pass: try to extract the manifest to learn the real id
  let manifestId = "__local__";
  try {
    const codeFiles = await extractCodeFiles(tarballBytes);
    const manifestText = codeFiles.get("manifest.json");
    if (manifestText) {
      const parsed = JSON.parse(manifestText);
      if (typeof parsed?.id === "string") manifestId = parsed.id;
    }
  } catch {
    /* fall through to validateBundle which will produce a proper error */
  }

  // Second pass: run the real validator with the now-known id
  const result = await validateBundle(tarballBytes, manifestId);

  if (!result.valid || !result.manifest || !result.files) {
    if (json) {
      console.log(JSON.stringify({ valid: false, errors: result.errors }, null, 2));
    } else {
      console.error(red(`\n✗ Bundle validation failed`));
      for (const err of result.errors ?? []) console.error(red(`  • ${err}`));
    }
    process.exit(1);
  }

  // Static scan
  const scan = runStaticScan(result.files, result.manifest);

  // Token estimate for the AI prompt (so you can see how big this would be)
  const promptText = buildPromptContent(result.files);
  const tokenEstimate = Math.ceil(promptText.length / 4);

  if (json) {
    console.log(
      JSON.stringify(
        {
          valid: true,
          manifest: {
            id: result.manifest.id,
            version: result.manifest.version,
            capabilities: result.manifest.capabilities,
            allowedHosts: result.manifest.allowedHosts,
            hookCount: result.manifest.hooks.length,
            routeCount: result.manifest.routes.length,
            adminEntry: result.manifest.admin?.entry ?? null,
          },
          stats: result.stats,
          checksum: result.checksum,
          scan: {
            dangerousPrimitiveCount: scan.dangerousPrimitiveCount,
            undeclaredHosts: scan.undeclaredHosts,
            findings: scan.findings,
          },
          aiPrompt: {
            charCount: promptText.length,
            tokenEstimate,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(green(`✓ Bundle valid`));
  console.log("");
  console.log(bold("Manifest"));
  console.log(`  ${cyan("id")}             ${result.manifest.id}`);
  console.log(`  ${cyan("version")}        ${result.manifest.version}`);
  console.log(
    `  ${cyan("capabilities")}   ${result.manifest.capabilities.length > 0 ? result.manifest.capabilities.join(", ") : dim("(none)")}`,
  );
  console.log(
    `  ${cyan("hooks")}          ${result.manifest.hooks.length > 0 ? result.manifest.hooks.length + " declared" : dim("(none)")}`,
  );
  console.log(
    `  ${cyan("routes")}         ${result.manifest.routes.length > 0 ? result.manifest.routes.length + " declared" : dim("(none)")}`,
  );
  console.log(
    `  ${cyan("allowedHosts")}   ${result.manifest.allowedHosts.length > 0 ? result.manifest.allowedHosts.join(", ") : dim("(none)")}`,
  );
  console.log("");

  console.log(bold("Bundle stats"));
  console.log(`  ${cyan("files")}          ${result.stats?.fileCount}`);
  console.log(
    `  ${cyan("compressed")}     ${(result.stats!.compressedSize / 1024).toFixed(1)} KB`,
  );
  console.log(
    `  ${cyan("decompressed")}   ${(result.stats!.decompressedSize / 1024).toFixed(1)} KB`,
  );
  console.log(`  ${cyan("checksum")}       ${result.checksum?.slice(0, 16)}…`);
  console.log("");

  console.log(bold("AI prompt size (if you ran in auto mode)"));
  console.log(`  ${cyan("chars")}          ${promptText.length.toLocaleString()}`);
  console.log(
    `  ${cyan("tokens (~)")}     ${tokenEstimate.toLocaleString()} ${dim("(rough: chars / 4)")}`,
  );
  console.log("");

  console.log(bold("Static scan"));
  if (scan.findings.length === 0) {
    console.log(`  ${green("✓ no findings")}`);
  } else {
    console.log(
      `  ${scan.findings.length} finding(s), ${scan.dangerousPrimitiveCount} dangerous primitive(s)`,
    );
    for (const f of scan.findings) {
      const cFn = severityColour(f.severity);
      const sev = cFn(f.severity.toUpperCase().padEnd(6));
      const loc = f.location ? dim(` (${f.location})`) : "";
      console.log(`  ${sev} ${bold(f.title)}${loc}`);
      console.log(`         ${dim(f.description)}`);
    }
  }
  if (scan.undeclaredHosts.length > 0) {
    console.log("");
    console.log(yellow(`  ⚠ Undeclared hosts referenced in code:`));
    for (const host of scan.undeclaredHosts) {
      console.log(`    - ${host}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(red(`\nUnexpected error: ${(err as Error).message}`));
  if ((err as Error).stack) console.error(dim((err as Error).stack!));
  process.exit(1);
});
