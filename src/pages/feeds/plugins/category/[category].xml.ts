// /feeds/plugins/category/[category].xml — per-category Atom feed.
// FEED-04. See 14-CONTEXT.md D-11/D-12 for the unknown-category 404 contract.
//
// Threat T-14-02: the dynamic [category] segment is user-controlled. The
// KNOWN_CATEGORIES enum gate runs BEFORE any D1 query so path-traversal,
// SQL-injection, and case-bypass payloads short-circuit to 404.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { KNOWN_CATEGORIES } from "../../../../lib/api/validation";
import { listPluginsByCategoryForFeed } from "../../../../lib/feeds/feed-queries";
import { buildFeed } from "../../../../lib/feeds/atom-builder";
import { pluginsToFeedEntries } from "../../../../lib/feeds/feed-mappers";

export const prerender = false;

const FEED_HEADERS = {
  "content-type": "application/atom+xml; charset=utf-8",
  "cache-control":
    "public, max-age=600, s-maxage=600, stale-while-revalidate=3600",
};

export const GET: APIRoute = async ({ params }) => {
  const category = (params.category ?? "").toLowerCase();

  if (
    !KNOWN_CATEGORIES.includes(category as (typeof KNOWN_CATEGORIES)[number])
  ) {
    // Unknown category — empty body, Atom content-type per D-12.
    return new Response("", { status: 404, headers: FEED_HEADERS });
  }

  try {
    const plugins = await listPluginsByCategoryForFeed(env.DB, category, 50);
    const xml = buildFeed({
      id: `tag:emdashcms.org,2026:feed:plugins:category:${category}`,
      title: `emdashcms.org — new plugins in ${category}`,
      selfUrl: `https://emdashcms.org/feeds/plugins/category/${category}.xml`,
      alternateUrl: `https://emdashcms.org/plugins/category/${category}`,
      entries: pluginsToFeedEntries(plugins, { kind: "new", category }),
    });
    return new Response(xml, { status: 200, headers: FEED_HEADERS });
  } catch (err) {
    console.error(`[feeds] category ${category} error:`, err);
    return new Response("", { status: 500, headers: FEED_HEADERS });
  }
};
