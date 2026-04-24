/**
 * Pure sitemap builder for /sitemap.xml (AIDX-08).
 *
 * Separated from the Astro endpoint so the string-building logic is
 * trivially unit-testable with zero D1 setup: pass a SitemapInput in,
 * get a valid XML document out. The endpoint at
 * `src/pages/sitemap.xml.ts` is a thin adapter that runs the keyset
 * queries and calls `buildSitemapXml` once.
 *
 * Sitemap protocol ceiling: each sitemap.xml file is capped at 50,000
 * URLs / 50 MB (uncompressed) by the sitemaps.org protocol. When the
 * marketplace catalog approaches that threshold — likely ~10,000
 * plugins + themes combined given per-entity category duplication —
 * split this file into a sitemap-index document pointing at per-type
 * child sitemaps (plugins, themes, categories, static). See
 * https://www.sitemaps.org/protocol.html#index for the schema.
 *
 * Scope (what this builder emits — confirmed against src/pages/):
 *   - 10 static pages (homepage, listings, guide, 3x docs, legal).
 *   - /plugins/{id}            for every published plugin row.
 *   - /themes/{id}             for every theme row.
 *   - /plugins/category/{slug} for every DISTINCT non-null plugins.category.
 *   - /themes/category/{slug}  for every DISTINCT non-null themes.category.
 *
 * Scope (what this builder does NOT emit, and why):
 *   - Hook browse pages — no routes exist in src/pages/ today.
 *   - Digest pages — Phase 14 owns those; it will extend this builder
 *     when it lands.
 *   - /dashboard/**, /api/**, /report/** — authenticated, non-HTML,
 *     or noindex action routes.
 */

const SITE_URL = "https://emdashcms.org";

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: string;
}

export interface SitemapInput {
  /** Published plugins keyed by id — `updated_at` is emitted as <lastmod>. */
  plugins: Array<{ id: string; updated_at: string }>;
  /** All themes — `updated_at` is emitted as <lastmod>. */
  themes: Array<{ id: string; updated_at: string }>;
  /** DISTINCT plugin category slugs with MAX(updated_at) of their plugins. */
  pluginCategories: Array<{ slug: string; lastmod: string }>;
  /** DISTINCT theme category slugs with MAX(updated_at) of their themes. */
  themeCategories: Array<{ slug: string; lastmod: string }>;
}

/**
 * Escape the five XML predefined entities so special characters in
 * plugin ids, theme ids, or category slugs survive a round trip
 * through an XML parser. Marketplace conventions don't normally allow
 * `&`, `<`, `>`, `"`, or `'` in slugs, but the sitemap is a
 * load-bearing search-engine surface — it must survive defensively.
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a single <url> entry. Optional fields are emitted in the
 * order the sitemap protocol documents: loc, lastmod, changefreq,
 * priority. Indentation uses two spaces for readability at the URL
 * level and four for the field rows — not load-bearing, but keeps the
 * output diffable during incident response.
 */
export function urlEntry(u: SitemapUrl): string {
  const parts: string[] = [
    `  <url>`,
    `    <loc>${xmlEscape(u.loc)}</loc>`,
  ];
  if (u.lastmod) parts.push(`    <lastmod>${u.lastmod}</lastmod>`);
  if (u.changefreq) parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
  if (u.priority) parts.push(`    <priority>${u.priority}</priority>`);
  parts.push(`  </url>`);
  return parts.join("\n");
}

/**
 * Build a complete sitemap.xml document from the four catalog inputs
 * plus the hardcoded static URL list. Returns a string the endpoint
 * streams straight back to the client.
 *
 * The static URL list must be kept in sync with the top-level
 * `src/pages/*.astro` and `src/pages/docs/*.astro` additions. When a
 * new public page ships in a later plan, add it here and add a test.
 * Dashboard, API, and report routes are intentionally omitted — they
 * are authenticated, non-HTML, or noindex.
 */
export function buildSitemapXml(input: SitemapInput): string {
  const now = new Date().toISOString();

  // Every static entry carries <lastmod>. Dynamic pages already had it,
  // but the static ones shipped without — which hurts on two surfaces:
  // Google's crawl scheduler has nothing to anchor re-crawls against,
  // and AI search engines treat a lastmod-less URL as stale. Using the
  // build timestamp is defensible because these pages are refreshed
  // with each deploy; it's always a real upper-bound on when the
  // content could have changed.
  const staticEntries: SitemapUrl[] = [
    { loc: `${SITE_URL}/`, lastmod: now, changefreq: "weekly", priority: "1.0" },
    { loc: `${SITE_URL}/plugins`, lastmod: now, changefreq: "daily", priority: "0.9" },
    { loc: `${SITE_URL}/themes`, lastmod: now, changefreq: "daily", priority: "0.9" },
    { loc: `${SITE_URL}/digest`, lastmod: now, changefreq: "weekly", priority: "0.7" },
    { loc: `${SITE_URL}/learn`, lastmod: now, changefreq: "weekly", priority: "0.8" },
    { loc: `${SITE_URL}/learn/what-is-emdash`, lastmod: now, changefreq: "monthly", priority: "0.7" },
    { loc: `${SITE_URL}/learn/plugin-system`, lastmod: now, changefreq: "monthly", priority: "0.7" },
    { loc: `${SITE_URL}/learn/manifest-schema`, lastmod: now, changefreq: "monthly", priority: "0.7" },
    { loc: `${SITE_URL}/learn/capabilities`, lastmod: now, changefreq: "monthly", priority: "0.7" },
    { loc: `${SITE_URL}/compare`, lastmod: now, changefreq: "weekly", priority: "0.7" },
    { loc: `${SITE_URL}/compare/emdash-vs-wordpress`, lastmod: now, changefreq: "monthly", priority: "0.7" },
    { loc: `${SITE_URL}/guide`, lastmod: now, changefreq: "monthly", priority: "0.5" },
    { loc: `${SITE_URL}/docs/contributors`, lastmod: now, changefreq: "monthly", priority: "0.5" },
    { loc: `${SITE_URL}/docs/moderators`, lastmod: now, changefreq: "monthly", priority: "0.5" },
    { loc: `${SITE_URL}/docs/security`, lastmod: now, changefreq: "monthly", priority: "0.5" },
    { loc: `${SITE_URL}/privacy`, lastmod: now, changefreq: "yearly", priority: "0.3" },
    { loc: `${SITE_URL}/terms`, lastmod: now, changefreq: "yearly", priority: "0.3" },
    { loc: `${SITE_URL}/code-of-conduct`, lastmod: now, changefreq: "yearly", priority: "0.3" },
  ];

  const pluginEntries: SitemapUrl[] = input.plugins.map((p) => ({
    loc: `${SITE_URL}/plugins/${p.id}`,
    lastmod: p.updated_at,
    changefreq: "weekly",
    priority: "0.8",
  }));

  const themeEntries: SitemapUrl[] = input.themes.map((t) => ({
    loc: `${SITE_URL}/themes/${t.id}`,
    lastmod: t.updated_at,
    changefreq: "weekly",
    priority: "0.8",
  }));

  const pluginCategoryEntries: SitemapUrl[] = input.pluginCategories.map((c) => ({
    loc: `${SITE_URL}/plugins/category/${c.slug}`,
    lastmod: c.lastmod,
    changefreq: "weekly",
    priority: "0.6",
  }));

  const themeCategoryEntries: SitemapUrl[] = input.themeCategories.map((c) => ({
    loc: `${SITE_URL}/themes/category/${c.slug}`,
    lastmod: c.lastmod,
    changefreq: "weekly",
    priority: "0.6",
  }));

  const all: SitemapUrl[] = [
    ...staticEntries,
    ...pluginEntries,
    ...themeEntries,
    ...pluginCategoryEntries,
    ...themeCategoryEntries,
  ];

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    all.map(urlEntry).join("\n") +
    `\n</urlset>\n`
  );
}
