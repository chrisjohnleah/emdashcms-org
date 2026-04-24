import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { buildSitemapXml, type SitemapInput } from "../lib/seo/sitemap";

/**
 * /sitemap.xml — dynamic Astro API route serving the marketplace's
 * search-engine sitemap (AIDX-08).
 *
 * Design:
 *   - Keyset-paginated reads over `plugins` and `themes` so the
 *     builder stays memory-bounded as the catalog grows. PAGE_SIZE is
 *     10,000, safely under the sitemap protocol's 50,000 URL ceiling
 *     (flagged in `src/lib/seo/sitemap.ts`).
 *   - Plugin filter matches `searchPlugins` exactly —
 *     `COALESCE(status, 'active') = 'active'` AND an EXISTS on a
 *     published/flagged version. Parity with the browse UI means the
 *     sitemap never lists a plugin that users cannot actually see.
 *   - Theme filter matches `searchThemes`: installable iff
 *     `repository_url IS NOT NULL OR npm_package IS NOT NULL`.
 *   - Category enumeration uses a single DISTINCT-grouped query per
 *     entity type; MAX(updated_at) becomes the <lastmod> so search
 *     engines re-crawl a category when any of its plugins change.
 *   - Response cached for one hour at the edge (s-maxage=3600). Long
 *     enough to absorb crawler traffic; short enough that a publish
 *     reflects in the sitemap within a single crawl cycle.
 *   - `prerender = false` is mandatory — the route reads live D1.
 */

export const prerender = false;

const PAGE_SIZE = 10000;

interface CatalogRow {
  id: string;
  updated_at: string;
}

interface CategoryRow {
  slug: string;
  lastmod: string;
}

// ---------------------------------------------------------------------------
// Plugin and theme keyset readers
// ---------------------------------------------------------------------------

async function fetchPluginsKeyset(db: D1Database): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  let cursor: string | null = null;

  // Matches searchPlugins filter semantics exactly so the sitemap
  // surfaces only URLs the browse UI would resolve to a real page.
  const baseSql = `
    SELECT id, updated_at
    FROM plugins
    WHERE COALESCE(status, 'active') = 'active'
      AND unlisted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM plugin_versions pv
        WHERE pv.plugin_id = plugins.id
          AND pv.status IN ('published', 'flagged')
      )`;

  while (true) {
    const result: D1Result = cursor
      ? await db
          .prepare(`${baseSql} AND id > ? ORDER BY id ASC LIMIT ?`)
          .bind(cursor, PAGE_SIZE)
          .all()
      : await db
          .prepare(`${baseSql} ORDER BY id ASC LIMIT ?`)
          .bind(PAGE_SIZE)
          .all();

    const page = result.results as unknown as CatalogRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

async function fetchThemesKeyset(db: D1Database): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  let cursor: string | null = null;

  // Matches searchThemes filter: themes are installable iff they have
  // a repository or an npm package to install from.
  const baseSql = `
    SELECT id, updated_at
    FROM themes
    WHERE (repository_url IS NOT NULL OR npm_package IS NOT NULL)`;

  while (true) {
    const result: D1Result = cursor
      ? await db
          .prepare(`${baseSql} AND id > ? ORDER BY id ASC LIMIT ?`)
          .bind(cursor, PAGE_SIZE)
          .all()
      : await db
          .prepare(`${baseSql} ORDER BY id ASC LIMIT ?`)
          .bind(PAGE_SIZE)
          .all();

    const page = result.results as unknown as CatalogRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DISTINCT category enumeration — one row per slug, MAX(updated_at) wins.
// ---------------------------------------------------------------------------

async function fetchPluginCategories(db: D1Database): Promise<CategoryRow[]> {
  const result = await db
    .prepare(
      `SELECT category AS slug, MAX(updated_at) AS lastmod
       FROM plugins
       WHERE category IS NOT NULL
         AND COALESCE(status, 'active') = 'active'
         AND unlisted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM plugin_versions pv
           WHERE pv.plugin_id = plugins.id
             AND pv.status IN ('published', 'flagged')
         )
       GROUP BY category
       ORDER BY category ASC`,
    )
    .all();
  return result.results as unknown as CategoryRow[];
}

async function fetchThemeCategories(db: D1Database): Promise<CategoryRow[]> {
  const result = await db
    .prepare(
      `SELECT category AS slug, MAX(updated_at) AS lastmod
       FROM themes
       WHERE category IS NOT NULL
         AND (repository_url IS NOT NULL OR npm_package IS NOT NULL)
       GROUP BY category
       ORDER BY category ASC`,
    )
    .all();
  return result.results as unknown as CategoryRow[];
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export const GET: APIRoute = async () => {
  const [plugins, themes, pluginCategories, themeCategories] =
    await Promise.all([
      fetchPluginsKeyset(env.DB),
      fetchThemesKeyset(env.DB),
      fetchPluginCategories(env.DB),
      fetchThemeCategories(env.DB),
    ]);

  const input: SitemapInput = {
    plugins,
    themes,
    pluginCategories,
    themeCategories,
  };
  const body = buildSitemapXml(input);

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
};
