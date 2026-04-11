/**
 * Hand-rolled Shields.io-compatible SVG badge renderer.
 *
 * Pure string templating — no external dependencies, no SVG library, no
 * DOM shims. Designed to fit the Workers 10ms CPU budget with room to
 * spare and to render consistently wherever READMEs are displayed.
 *
 * Layout: flat-square two-pill badge, 20px high, 3px corner radius,
 * Verdana font stack (matches Shields.io for visual continuity). The
 * left pill is the slate-gray label; the right pill carries the value
 * in one of the semantic colors below.
 *
 * Width math is an approximation — Verdana 11px averages ~6.5px/glyph
 * for labels and ~7px/glyph for the (often mixed-case) value. We err
 * wide rather than narrow so text never clips. Exact pixel precision
 * does not matter for tiny README badges.
 */

/**
 * Self-contained flat hex palette. Kept as literal strings so the SVG
 * renders identically wherever it's embedded (GitHub's markdown
 * sanitizer strips external CSS, so CSS variables would break).
 *
 * The semantic buckets (success / warn / danger / muted) mirror the
 * in-app TrustTierBadge styling — see D-07 and 13-CONTEXT.md.
 */
export const BADGE_COLORS = {
  success: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  muted: "#8b949e",
  label: "#555",
} as const;

export type BadgeColor = (typeof BADGE_COLORS)[keyof typeof BADGE_COLORS];

/**
 * Escape the five XML-reserved characters. UTF-8 characters such as the
 * em-dash are valid in XML text content and pass through unchanged.
 *
 * Defence-in-depth for T-13-01 and T-13-05 — badge values come from
 * trusted server-side derivations and parameterized D1 reads, but
 * escaping the interpolation point closes the XSS vector completely
 * if a future change ever leaks untrusted text into a badge.
 */
export const xmlEscape = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

/**
 * Render a Shields.io-style flat-square badge as a standalone SVG
 * string. Both `label` and `value` are xml-escaped before being
 * interpolated into the template.
 */
export function renderBadge(
  label: string,
  value: string,
  color: BadgeColor,
): string {
  const labelEsc = xmlEscape(label);
  const valueEsc = xmlEscape(value);

  // Verdana width approximations. Err wide — text must never clip.
  const labelWidth = Math.ceil(label.length * 6.5) + 10;
  const valueWidth = Math.ceil(value.length * 7) + 10;
  const totalWidth = labelWidth + valueWidth;
  const labelCenterX = labelWidth / 2;
  const valueCenterX = labelWidth + valueWidth / 2;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${labelEsc}: ${valueEsc}">` +
    `<title>${labelEsc}: ${valueEsc}</title>` +
    `<linearGradient id="s" x2="0" y2="100%">` +
    `<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>` +
    `<stop offset="1" stop-opacity=".1"/>` +
    `</linearGradient>` +
    `<clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${labelWidth}" height="20" fill="${BADGE_COLORS.label}"/>` +
    `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>` +
    `<rect width="${totalWidth}" height="20" fill="url(#s)"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${labelCenterX}" y="15">${labelEsc}</text>` +
    `<text x="${valueCenterX}" y="15">${valueEsc}</text>` +
    `</g>` +
    `</svg>`
  );
}
