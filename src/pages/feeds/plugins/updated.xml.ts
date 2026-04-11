// /feeds/plugins/updated.xml — Atom 1.0 feed of the 50 most recent
// published/flagged plugin_versions rows (one entry per version).
// FEED-02. See .planning/phases/14-feeds-and-weekly-digest/14-CONTEXT.md D-09.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listRecentPluginVersionsForFeed } from "../../../lib/feeds/feed-queries";
import { buildFeed } from "../../../lib/feeds/atom-builder";
import { pluginVersionsToFeedEntries } from "../../../lib/feeds/feed-mappers";

export const prerender = false;

const FEED_HEADERS = {
  "content-type": "application/atom+xml; charset=utf-8",
  "cache-control":
    "public, max-age=600, s-maxage=600, stale-while-revalidate=3600",
};

export const GET: APIRoute = async () => {
  try {
    const versions = await listRecentPluginVersionsForFeed(env.DB, 50);
    const xml = buildFeed({
      id: "tag:emdashcms.org,2026:feed:plugins:updated",
      title: "emdashcms.org — updated plugins",
      selfUrl: "https://emdashcms.org/feeds/plugins/updated.xml",
      alternateUrl: "https://emdashcms.org/plugins",
      entries: pluginVersionsToFeedEntries(versions),
    });
    return new Response(xml, { status: 200, headers: FEED_HEADERS });
  } catch (err) {
    console.error("[feeds] plugins/updated.xml error:", err);
    return new Response("", {
      status: 500,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    });
  }
};
