// /feeds/plugins/new.xml — Atom 1.0 feed of the 50 most recent active plugins.
// FEED-01. See .planning/phases/14-feeds-and-weekly-digest/14-CONTEXT.md D-01..D-18.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listRecentPluginsForFeed } from "../../../lib/feeds/feed-queries";
import { buildFeed } from "../../../lib/feeds/atom-builder";
import { pluginsToFeedEntries } from "../../../lib/feeds/feed-mappers";

export const prerender = false;

const FEED_HEADERS = {
  "content-type": "application/atom+xml; charset=utf-8",
  "cache-control":
    "public, max-age=600, s-maxage=600, stale-while-revalidate=3600",
};

export const GET: APIRoute = async () => {
  try {
    const plugins = await listRecentPluginsForFeed(env.DB, 50);
    const xml = buildFeed({
      id: "tag:emdashcms.org,2026:feed:plugins:new",
      title: "emdashcms.org — new plugins",
      selfUrl: "https://emdashcms.org/feeds/plugins/new.xml",
      alternateUrl: "https://emdashcms.org/plugins",
      entries: pluginsToFeedEntries(plugins, { kind: "new" }),
    });
    return new Response(xml, { status: 200, headers: FEED_HEADERS });
  } catch (err) {
    console.error("[feeds] plugins/new.xml error:", err);
    return new Response("", {
      status: 500,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    });
  }
};
