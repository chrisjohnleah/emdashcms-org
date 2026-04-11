/**
 * OG image rendering for plugin and theme social share previews.
 *
 * This module is the generation engine; the request-path routes
 * (src/pages/og/plugin/[id].png.ts, src/pages/og/theme/[id].png.ts)
 * NEVER call these functions synchronously. Generation costs 200-500ms
 * CPU cold (Satori -> SVG -> resvg-wasm -> PNG), which is 20-50x the
 * 10ms Cloudflare Workers Free-tier request-path CPU ceiling. The
 * request path is a thin R2 proxy; generation runs in the OG_QUEUE
 * consumer (see `src/lib/seo/og-queue.ts`) with the 90s CPU budget
 * declared in `wrangler.jsonc`.
 *
 * Design direction (see `.planning/phases/16-ai-and-social-discoverability/16-CONTEXT.md`
 * D-13 and memory `project_design_direction.md`): warm-light
 * editorial palette keyed on `#fbf8f1`, Inter for display text,
 * JetBrains Mono for the wordmark, literal em-dash as an accent.
 */

import { ImageResponse } from 'workers-og';
import type {
  MarketplacePluginDetail,
  MarketplaceThemeDetail,
} from '../../types/marketplace';
// Fonts are base64-inlined in `og-fonts.ts` (generated from the .woff2
// files in src/assets/fonts/ by scripts/build-fonts.mjs). Inlining is
// the only portable way to ship font bytes across Astro-Vite and
// vitest-pool-workers bundlers — Vite emits asset URLs for `.woff2`
// imports and wrangler's esbuild treats them as external.
import { interRegular, interBold, jetBrainsMono } from './og-fonts';

/**
 * 68-byte 1x1 transparent PNG returned when:
 *  - the request-path route cache-misses R2 and needs a placeholder
 *    while the OG_QUEUE consumer generates the real image;
 *  - the consumer itself encounters a render error and needs a safe
 *    byte sequence to fall through with.
 *
 * Social crawlers tolerate this gracefully — Open Graph only requires
 * that `og:image` resolve to a readable image of any dimensions.
 */
export const PLACEHOLDER_PNG: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0xfa, 0xcf, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * Satori font table used by every OG render. Pre-loaded at module
 * evaluation time so the queue consumer doesn't pay a font parse cost
 * on every message — the cost is amortised across an entire isolate
 * lifetime.
 */
const FONTS = [
  {
    name: 'Inter',
    data: interRegular as unknown as ArrayBuffer,
    weight: 400 as const,
    style: 'normal' as const,
  },
  {
    name: 'Inter',
    data: interBold as unknown as ArrayBuffer,
    weight: 700 as const,
    style: 'normal' as const,
  },
  {
    name: 'JetBrains Mono',
    data: jetBrainsMono as unknown as ArrayBuffer,
    weight: 400 as const,
    style: 'normal' as const,
  },
];

/**
 * Truncate a string to `max` characters with an ellipsis. Used to
 * keep plugin/theme names within the OG template's headline box so
 * Satori doesn't overflow the 1200x630 canvas.
 */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}\u2026`;
}

/**
 * Escape the five XSS-relevant characters before interpolating any
 * user-supplied string into the Satori HTML input. `workers-og` uses
 * an HTMLRewriter parser under the hood; an unescaped `<` in a
 * plugin name would break the element tree.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Palette (kept in sync with Tailwind tokens in src/styles/global.css).
const BG = '#fbf8f1'; // paper
const INK = '#1a1a1a'; // ink
const INK_MUTED = '#6b6b6b'; // ink-muted
const ACCENT = '#c77c3c'; // accent-deep (warm amber em-dash)

/**
 * Build the Satori-compatible HTML for an OG card.
 *
 * Satori rules (the painful ones):
 *  - EVERY `<div>` with more than one child must declare `display: flex`
 *    (or `display: none`). Satori refuses to guess block layout.
 *  - Only a narrow CSS subset is supported: flex, box model, colors,
 *    fonts. No grid, no pseudo-elements, no external images, no
 *    background gradients, no animations.
 *  - The HTML parser treats whitespace between elements as text nodes,
 *    which can silently push you past the one-child limit. We emit the
 *    template as a single line with NO whitespace between tags.
 *
 * See https://github.com/vercel/satori#css-compatibility.
 *
 * The plugin and theme cards share the same structure; the only
 * difference is the bottom-right pill content (install count vs.
 * first keyword).
 */
function buildCardHtml(options: {
  name: string;
  author: string;
  pill: string;
}): string {
  const { name, author, pill } = options;
  // Built as a single line — see the Satori whitespace note above.
  return (
    `<div style="width:1200px;height:630px;display:flex;flex-direction:column;background:${BG};padding:80px;font-family:'Inter',sans-serif;">` +
    `<div style="display:flex;flex-direction:row;align-items:center;justify-content:space-between;">` +
    `<div style="display:flex;font-family:'JetBrains Mono',monospace;font-size:28px;color:${INK_MUTED};">emdash &mdash;</div>` +
    `<div style="display:flex;font-size:20px;color:${INK_MUTED};">emdashcms.org</div>` +
    `</div>` +
    `<div style="display:flex;flex-direction:column;flex-grow:1;justify-content:center;">` +
    `<div style="display:flex;font-size:72px;font-weight:700;color:${INK};line-height:1.1;">${name}</div>` +
    `<div style="display:flex;font-size:32px;color:${INK_MUTED};margin-top:24px;">by @${author}</div>` +
    `</div>` +
    `<div style="display:flex;flex-direction:row;align-items:flex-end;justify-content:space-between;">` +
    `<div style="display:flex;font-size:96px;color:${ACCENT};line-height:1;font-weight:400;">&mdash;</div>` +
    `<div style="display:flex;flex-direction:row;background:${INK};color:${BG};padding:16px 28px;font-size:24px;font-weight:700;">${pill}</div>` +
    `</div>` +
    `</div>`
  );
}

function buildPluginTemplateHtml(plugin: MarketplacePluginDetail): string {
  const name = escapeHtml(truncate(plugin.name, 60));
  const author = escapeHtml(plugin.author.name);
  const installs = plugin.installCount.toLocaleString('en-US');
  return buildCardHtml({ name, author, pill: `${installs} installs` });
}

function buildThemeTemplateHtml(theme: MarketplaceThemeDetail): string {
  const name = escapeHtml(truncate(theme.name, 60));
  const author = escapeHtml(theme.author.name);
  const keyword = escapeHtml(theme.keywords[0] ?? 'theme');
  return buildCardHtml({ name, author, pill: `#${keyword}` });
}

/**
 * Render the branded OG card for a plugin as a 1200x630 PNG.
 *
 * MUST NOT be called on the request path — this function runs Satori
 * + resvg-wasm, which blows past the 10ms Free-tier CPU budget. Call
 * it from the OG_QUEUE consumer (`handleOgJob` in og-queue.ts) only.
 */
export async function renderPluginOgImage(
  plugin: MarketplacePluginDetail,
): Promise<Uint8Array> {
  const html = buildPluginTemplateHtml(plugin);
  const response = new ImageResponse(html, {
    width: 1200,
    height: 630,
    format: 'png',
    fonts: FONTS,
  });
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Render the branded OG card for a theme as a 1200x630 PNG.
 *
 * Same CPU-budget constraint as `renderPluginOgImage` — queue
 * consumer only, never request-path.
 */
export async function renderThemeOgImage(
  theme: MarketplaceThemeDetail,
): Promise<Uint8Array> {
  const html = buildThemeTemplateHtml(theme);
  const response = new ImageResponse(html, {
    width: 1200,
    height: 630,
    format: 'png',
    fonts: FONTS,
  });
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}
