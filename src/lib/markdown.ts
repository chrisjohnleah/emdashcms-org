/**
 * Publisher markdown renderer for plugin descriptions.
 *
 * Every description is untrusted input — the publisher types it, we
 * store it verbatim in D1, and this function is the only place it ever
 * becomes HTML. Safety is enforced by:
 *
 *   - `html: false` — raw HTML inside the markdown source is escaped
 *     on output, so `<script>`, `<iframe>`, inline event handlers,
 *     etc. can never reach the DOM. No DOMPurify needed.
 *   - markdown-it's built-in link scheme validator rejects
 *     `javascript:`, `vbscript:`, `file:`, and `data:` URIs unless
 *     they're `data:image/...`, so `[click](javascript:alert(1))`
 *     renders with a stripped href.
 *   - `linkify: true` auto-converts bare URLs but runs them through
 *     the same validator.
 *   - `breaks: false` preserves author paragraphs without turning
 *     every newline into a `<br>`, matching how GitHub and npm render
 *     README-style content.
 *
 * The result is returned as a plain HTML string for use with Astro's
 * `set:html` directive inside a scoped `.plugin-prose` wrapper that
 * restyles the output to match the editorial theme.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
});

// Harden outbound links: every rendered `<a>` gets `target="_blank"`
// so the plugin listing doesn't navigate away, plus
// `rel="noopener noreferrer"` to defeat reverse-tabnabbing
// (window.opener → parent frame hijack) and strip the Referer header
// on the outbound hit. markdown-it exposes no option for this, so we
// wrap `link_open` following the pattern from its own docs.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * Render a publisher-supplied markdown string to sanitised HTML.
 *
 * Returns `null` on empty / null / whitespace-only input so callers
 * can guard with `{html && <section set:html={html} />}` without
 * emitting an empty container.
 */
export function renderPluginMarkdown(source: string | null): string | null {
  if (!source) return null;
  const trimmed = source.trim();
  if (!trimmed) return null;
  return md.render(trimmed);
}
