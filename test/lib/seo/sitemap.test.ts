/**
 * Unit tests for src/lib/seo/sitemap.ts — the pure sitemap builder that
 * powers /sitemap.xml. No D1 dependency; every test constructs fixtures
 * inline and exercises the library functions directly.
 *
 * Covered surface:
 *   - xmlEscape: all five XML entities + safe-string no-op.
 *   - urlEntry: bare-loc, full-option, and XML-escape of loc.
 *   - buildSitemapXml: shape, static URL coverage, dynamic URL
 *     enumeration, escape propagation, and the 50,000-URL threshold
 *     note in the source file.
 */

import { describe, it, expect } from "vitest";
import {
  buildSitemapXml,
  urlEntry,
  xmlEscape,
  type SitemapInput,
} from "../../../src/lib/seo/sitemap";
// Vite ?raw import lets us assert against the source text inside the
// Workers test isolate (no host `readFileSync` available).
import sitemapSource from "../../../src/lib/seo/sitemap.ts?raw";

// ---------------------------------------------------------------------------
// xmlEscape — every XML predefined entity + a no-op for clean input.
// ---------------------------------------------------------------------------

describe("xmlEscape", () => {
  it("escapes ampersand", () => {
    expect(xmlEscape("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(xmlEscape("<a>")).toBe("&lt;a&gt;");
  });

  it("escapes double quotes", () => {
    expect(xmlEscape('"quoted"')).toBe("&quot;quoted&quot;");
  });

  it("escapes single quotes", () => {
    expect(xmlEscape("o'brien")).toBe("o&apos;brien");
  });

  it("passes safe input through unchanged", () => {
    expect(xmlEscape("clean-slug")).toBe("clean-slug");
  });
});

// ---------------------------------------------------------------------------
// urlEntry — builds one <url> XML block, optional fields in spec order.
// ---------------------------------------------------------------------------

describe("urlEntry", () => {
  it("renders just <loc> when no optional fields are given", () => {
    expect(urlEntry({ loc: "https://emdashcms.org/plugins/foo" })).toBe(
      `  <url>\n    <loc>https://emdashcms.org/plugins/foo</loc>\n  </url>`,
    );
  });

  it("renders lastmod, changefreq, priority in sitemap-protocol order", () => {
    const out = urlEntry({
      loc: "https://emdashcms.org/plugins/bar",
      lastmod: "2026-04-11T10:00:00.000Z",
      changefreq: "weekly",
      priority: "0.8",
    });
    expect(out).toContain("<lastmod>2026-04-11T10:00:00.000Z</lastmod>");
    expect(out).toContain("<changefreq>weekly</changefreq>");
    expect(out).toContain("<priority>0.8</priority>");
    // The protocol specifies <loc>, <lastmod>, <changefreq>, <priority>.
    const locIdx = out.indexOf("<loc>");
    const lastmodIdx = out.indexOf("<lastmod>");
    const changefreqIdx = out.indexOf("<changefreq>");
    const priorityIdx = out.indexOf("<priority>");
    expect(locIdx).toBeLessThan(lastmodIdx);
    expect(lastmodIdx).toBeLessThan(changefreqIdx);
    expect(changefreqIdx).toBeLessThan(priorityIdx);
  });

  it("XML-escapes the loc value", () => {
    const out = urlEntry({ loc: "https://emdashcms.org/plugins/foo&bar" });
    expect(out).toContain("<loc>https://emdashcms.org/plugins/foo&amp;bar</loc>");
    expect(out).not.toContain("foo&bar</loc>");
  });
});

// ---------------------------------------------------------------------------
// buildSitemapXml — the main entry point used by the Astro endpoint.
// ---------------------------------------------------------------------------

const EMPTY_INPUT: SitemapInput = {
  plugins: [],
  themes: [],
  pluginCategories: [],
  themeCategories: [],
};

const STATIC_LOCS = [
  "https://emdashcms.org/",
  "https://emdashcms.org/plugins",
  "https://emdashcms.org/themes",
  "https://emdashcms.org/guide",
  "https://emdashcms.org/docs/contributors",
  "https://emdashcms.org/docs/moderators",
  "https://emdashcms.org/docs/security",
  "https://emdashcms.org/privacy",
  "https://emdashcms.org/terms",
  "https://emdashcms.org/code-of-conduct",
];

describe("buildSitemapXml", () => {
  it("returns a valid urlset document with XML declaration and namespace", () => {
    const xml = buildSitemapXml(EMPTY_INPUT);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml.endsWith("</urlset>\n")).toBe(true);
  });

  it("emits every static URL even when the catalog is empty", () => {
    const xml = buildSitemapXml(EMPTY_INPUT);
    for (const loc of STATIC_LOCS) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
  });

  it("emits <lastmod> on every static entry", () => {
    // Static pages shipped without <lastmod> originally, which starves
    // Google's crawl scheduler and makes AI search engines treat the
    // URL as stale. Every static entry must now carry a timestamp.
    const xml = buildSitemapXml(EMPTY_INPUT);
    // One lastmod per static entry — the body is a URL ↔ lastmod pair,
    // so the count should match the number of static locs exactly
    // when the catalog is empty.
    const lastmodCount = (xml.match(/<lastmod>/g) ?? []).length;
    expect(lastmodCount).toBe(STATIC_LOCS.length);
  });

  it("emits one <url> per plugin with the provided updated_at as <lastmod>", () => {
    const xml = buildSitemapXml({
      ...EMPTY_INPUT,
      plugins: [
        { id: "seo-toolkit", updated_at: "2026-03-20T12:00:00.000Z" },
        { id: "analytics-pro", updated_at: "2026-03-18T09:00:00.000Z" },
        { id: "form-builder", updated_at: "2026-03-10T16:00:00.000Z" },
      ],
    });
    expect(xml).toContain("<loc>https://emdashcms.org/plugins/seo-toolkit</loc>");
    expect(xml).toContain(
      "<loc>https://emdashcms.org/plugins/analytics-pro</loc>",
    );
    expect(xml).toContain(
      "<loc>https://emdashcms.org/plugins/form-builder</loc>",
    );
    expect(xml).toContain("<lastmod>2026-03-20T12:00:00.000Z</lastmod>");
    expect(xml).toContain("<lastmod>2026-03-18T09:00:00.000Z</lastmod>");
    expect(xml).toContain("<lastmod>2026-03-10T16:00:00.000Z</lastmod>");
  });

  it("emits one <url> per theme with the provided updated_at as <lastmod>", () => {
    const xml = buildSitemapXml({
      ...EMPTY_INPUT,
      themes: [
        { id: "docs-theme", updated_at: "2026-03-10T11:00:00.000Z" },
        { id: "dark-mode", updated_at: "2026-03-28T12:00:00.000Z" },
      ],
    });
    expect(xml).toContain("<loc>https://emdashcms.org/themes/docs-theme</loc>");
    expect(xml).toContain("<loc>https://emdashcms.org/themes/dark-mode</loc>");
    expect(xml).toContain("<lastmod>2026-03-10T11:00:00.000Z</lastmod>");
    expect(xml).toContain("<lastmod>2026-03-28T12:00:00.000Z</lastmod>");
  });

  it("emits one <url> per plugin category at /plugins/category/{slug}", () => {
    const xml = buildSitemapXml({
      ...EMPTY_INPUT,
      pluginCategories: [
        { slug: "editor", lastmod: "2026-04-10T00:00:00.000Z" },
        { slug: "publishing", lastmod: "2026-04-05T00:00:00.000Z" },
      ],
    });
    expect(xml).toContain(
      "<loc>https://emdashcms.org/plugins/category/editor</loc>",
    );
    expect(xml).toContain(
      "<loc>https://emdashcms.org/plugins/category/publishing</loc>",
    );
  });

  it("emits one <url> per theme category at /themes/category/{slug}", () => {
    const xml = buildSitemapXml({
      ...EMPTY_INPUT,
      themeCategories: [
        { slug: "documentation", lastmod: "2026-04-08T00:00:00.000Z" },
      ],
    });
    expect(xml).toContain(
      "<loc>https://emdashcms.org/themes/category/documentation</loc>",
    );
  });

  it("produces exactly the static URLs when every dynamic input is empty", () => {
    const xml = buildSitemapXml(EMPTY_INPUT);
    const locCount = (xml.match(/<loc>/g) ?? []).length;
    expect(locCount).toBe(STATIC_LOCS.length);
  });

  it("XML-escapes special characters in plugin ids and category slugs", () => {
    const xml = buildSitemapXml({
      ...EMPTY_INPUT,
      plugins: [{ id: "foo&bar", updated_at: "2026-04-01T00:00:00.000Z" }],
      pluginCategories: [
        { slug: "q&a", lastmod: "2026-04-01T00:00:00.000Z" },
      ],
    });
    expect(xml).toContain(
      "<loc>https://emdashcms.org/plugins/foo&amp;bar</loc>",
    );
    expect(xml).toContain(
      "<loc>https://emdashcms.org/plugins/category/q&amp;a</loc>",
    );
    // The raw ampersand must NOT appear inside any <loc> block.
    const rawLoc = /<loc>[^<]*foo&bar[^<]*<\/loc>/;
    expect(xml).not.toMatch(rawLoc);
  });

  it("is well-formed XML (every <url> has a matching </url>)", () => {
    const xml = buildSitemapXml({
      ...EMPTY_INPUT,
      plugins: [{ id: "p1", updated_at: "2026-04-01T00:00:00.000Z" }],
      themes: [{ id: "t1", updated_at: "2026-04-01T00:00:00.000Z" }],
    });
    const openCount = (xml.match(/<url>/g) ?? []).length;
    const closeCount = (xml.match(/<\/url>/g) ?? []).length;
    expect(openCount).toBe(closeCount);
    expect(openCount).toBeGreaterThanOrEqual(STATIC_LOCS.length + 2);
    // <urlset> wrapper must open and close exactly once.
    expect((xml.match(/<urlset /g) ?? []).length).toBe(1);
    expect((xml.match(/<\/urlset>/g) ?? []).length).toBe(1);
  });

  it("source code contains the 50,000-URL protocol threshold note", () => {
    // Sitemap protocol caps each file at 50,000 URLs / 50 MB. The
    // source must carry a reminder so the next engineer knows to split
    // into a sitemap-index when the catalog grows.
    expect(sitemapSource).toMatch(/50[,]?000/);
  });
});
