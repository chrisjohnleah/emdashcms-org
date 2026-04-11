#!/usr/bin/env node
/**
 * Regenerate `src/lib/seo/og-fonts.ts` from the source `.woff2` files
 * in `src/assets/fonts/`.
 *
 * Why this exists: `src/lib/seo/og-image.ts` needs raw font bytes at
 * runtime to feed Satori via `workers-og`. Astro uses Vite (which
 * emits asset URLs for `.woff2` imports by default) while the
 * vitest-pool-workers test harness uses wrangler's own esbuild
 * (which treats unknown imports as external). The only path that
 * works in both is to inline the fonts as base64 strings in a
 * regular `.ts` module, which is what this script produces.
 *
 * Usage:
 *   node scripts/build-fonts.mjs
 *
 * Run this after replacing any file under `src/assets/fonts/`. The
 * generated output is checked into git — tests and deploys read it
 * directly, they don't invoke this script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const FONT_DIR = join(repoRoot, "src/assets/fonts");
const OUT_FILE = join(repoRoot, "src/lib/seo/og-fonts.ts");

// NOTE: Satori (via `workers-og`) only accepts TrueType (.ttf) and
// OpenType (.otf) font files. It explicitly rejects `.woff2` (see
// Phase 16 Plan 02 Task 1 failure trace: `Unsupported OpenType signature
// wOF2`). If a future contributor drops in a `.woff2` file here, the
// OG render pipeline will throw at request-time — keep these TTF.
const FONTS = {
  interRegular: "Inter-Regular.ttf",
  interBold: "Inter-Bold.ttf",
  jetBrainsMono: "JetBrainsMono-Regular.ttf",
};

function chunk(s, width) {
  const out = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out;
}

const lines = [];
lines.push("/**");
lines.push(" * Auto-generated: base64 inlined font data for OG image rendering.");
lines.push(" *");
lines.push(" * The source .woff2 files live alongside this module in");
lines.push(" * src/assets/fonts/. Regenerate with scripts/build-fonts.mjs after");
lines.push(" * replacing a .woff2 file. Base64 inlining is the only portable way");
lines.push(" * to ship binary font data across Astro-Vite and vitest-pool-workers");
lines.push(" * bundlers without writing a custom plugin for each.");
lines.push(" */");
lines.push("");
lines.push("function decode(b64: string): Uint8Array {");
lines.push("  const bin = atob(b64);");
lines.push("  const out = new Uint8Array(bin.length);");
lines.push("  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);");
lines.push("  return out;");
lines.push("}");
lines.push("");

for (const [exportName, fileName] of Object.entries(FONTS)) {
  const bytes = readFileSync(join(FONT_DIR, fileName));
  const b64 = bytes.toString("base64");
  const literalName = exportName.toUpperCase() + "_B64";

  lines.push(`// Source: ${fileName} (${bytes.length} bytes)`);
  lines.push(`const ${literalName} =`);
  const parts = chunk(b64, 76).map((c) => `  ${JSON.stringify(c)}`);
  lines.push(parts.join(" +\n") + ";");
  lines.push(`export const ${exportName} = decode(${literalName});`);
  lines.push("");
}

writeFileSync(OUT_FILE, lines.join("\n"));
console.log(`Wrote ${OUT_FILE}`);
