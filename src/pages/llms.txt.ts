import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { searchPlugins, searchThemes } from "../lib/db/queries";
import { buildLlmsTxt } from "../lib/seo/llms-txt";

/**
 * /llms.txt — machine-readable marketplace index for AI crawlers.
 *
 * Served as a dynamic Astro API route so the contents reflect live
 * D1 state without a rebuild/deploy. The response is cached for an
 * hour at the edge (s-maxage=3600), which is enough to absorb AI
 * crawl traffic without staleness drifting past a single publish
 * cycle.
 *
 * Sections (per D-01..D-04 and the llms.txt spec):
 *   1. Featured Plugins — top 25 by install count.
 *   2. Recently Updated Plugins — next 25 by updated_at, excluding
 *      anything already featured.
 *   3. Themes — top 25 by updated_at.
 *
 * Plugins with a failed audit are naturally excluded because
 * searchPlugins filters to `status IN ('published', 'flagged')`
 * internally — rejected versions never surface.
 *
 * Hard cap: 75 items total. The llms.txt spec is a concise "here's
 * what matters" file, not a full sitemap — crawlers that want the
 * full list follow sitemap.xml (Plan 02).
 */

export const prerender = false;

export const GET: APIRoute = async () => {
  const [installsResult, updatedResult, themesResult] = await Promise.all([
    searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 25,
    }),
    // Request 50 so we have headroom to filter out anything already in
    // the Featured section before we slice to 25.
    searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "updated",
      cursor: null,
      limit: 50,
    }),
    searchThemes(env.DB, {
      query: "",
      category: null,
      keyword: null,
      sort: "updated",
      cursor: null,
      limit: 25,
    }),
  ]);

  const featuredIds = new Set(installsResult.items.map((p) => p.id));
  const recentlyUpdated = updatedResult.items
    .filter((p) => !featuredIds.has(p.id))
    .slice(0, 25);

  const body = buildLlmsTxt({
    featured: installsResult.items,
    recentlyUpdated,
    themes: themesResult.items,
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
};
