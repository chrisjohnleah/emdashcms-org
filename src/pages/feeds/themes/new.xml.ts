// /feeds/themes/new.xml — Atom 1.0 feed of the 50 most recent active themes.
// FEED-03. See .planning/phases/14-feeds-and-weekly-digest/14-CONTEXT.md D-10.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listRecentThemesForFeed } from "../../../lib/feeds/feed-queries";
import { buildFeed } from "../../../lib/feeds/atom-builder";
import { themesToFeedEntries } from "../../../lib/feeds/feed-mappers";

export const prerender = false;

const FEED_HEADERS = {
  "content-type": "application/atom+xml; charset=utf-8",
  "cache-control":
    "public, max-age=600, s-maxage=600, stale-while-revalidate=3600",
};

export const GET: APIRoute = async () => {
  try {
    const themes = await listRecentThemesForFeed(env.DB, 50);
    const xml = buildFeed({
      id: "tag:emdashcms.org,2026:feed:themes:new",
      title: "emdashcms.org — new themes",
      selfUrl: "https://emdashcms.org/feeds/themes/new.xml",
      alternateUrl: "https://emdashcms.org/themes",
      entries: themesToFeedEntries(themes),
    });
    return new Response(xml, { status: 200, headers: FEED_HEADERS });
  } catch (err) {
    console.error("[feeds] themes/new.xml error:", err);
    return new Response("", {
      status: 500,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    });
  }
};
