// /feeds/digest.xml — Atom 1.0 feed of the most recent weekly digests.
//
// The digest archive is the marketplace's editorial freshness surface:
// a new permanent page lands every Sunday. Exposing it as a subscribable
// feed lets RSS readers, IFTTT-style pipes, and — critically — AI
// crawlers that honour feed autodiscovery track marketplace activity
// without having to poll the catalog itself.
//
// Mirrors the conventions in src/pages/feeds/plugins/*: Atom 1.0,
// hand-rolled via buildFeed, cached the same way. Entry cap is the
// shared MAX_ENTRIES (50) in atom-builder.

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { buildFeed, type FeedEntry } from "../../lib/feeds/atom-builder";
import {
  parseIsoWeekSlug,
  formatHumanRange,
} from "../../lib/feeds/iso-week";
import type { WeeklyDigestManifest } from "../../lib/feeds/digest-generator";

export const prerender = false;

const FEED_HEADERS = {
  "content-type": "application/atom+xml; charset=utf-8",
  "cache-control":
    "public, max-age=600, s-maxage=600, stale-while-revalidate=3600",
};

const SITE_URL = "https://emdashcms.org";

interface DigestFeedRow {
  iso_week: string;
  generated_at: string;
  manifest_json: string;
}

function summaryFor(counts: WeeklyDigestManifest["counts"]): string {
  if (
    counts.newPlugins === 0 &&
    counts.updatedPlugins === 0 &&
    counts.newThemes === 0
  ) {
    return "Quiet week — no new or updated items on the marketplace.";
  }
  const parts: string[] = [];
  if (counts.newPlugins > 0) {
    parts.push(
      `${counts.newPlugins} new plugin${counts.newPlugins === 1 ? "" : "s"}`,
    );
  }
  if (counts.updatedPlugins > 0) {
    parts.push(
      `${counts.updatedPlugins} plugin update${counts.updatedPlugins === 1 ? "" : "s"}`,
    );
  }
  if (counts.newThemes > 0) {
    parts.push(
      `${counts.newThemes} new theme${counts.newThemes === 1 ? "" : "s"}`,
    );
  }
  return `${parts.join(" · ")} on the EmDash CMS community marketplace.`;
}

export const GET: APIRoute = async () => {
  try {
    const result = await env.DB.prepare(
      `SELECT iso_week, generated_at, manifest_json
       FROM weekly_digests
       ORDER BY iso_week DESC
       LIMIT 50`,
    ).all<DigestFeedRow>();

    const entries: FeedEntry[] = (result.results ?? []).map((row) => {
      const manifest = JSON.parse(row.manifest_json) as WeeklyDigestManifest;
      const week = parseIsoWeekSlug(row.iso_week);
      const human = week ? formatHumanRange(week) : row.iso_week;
      const alternateUrl = `${SITE_URL}/digest/${row.iso_week}`;
      return {
        id: `tag:emdashcms.org,2026:digest:${row.iso_week}`,
        title: `${human} — weekly digest`,
        updated: row.generated_at,
        alternateUrl,
        summary: summaryFor(manifest.counts),
        contentHtml: null,
        author: { name: "emdashcms.org", uri: SITE_URL },
      };
    });

    const xml = buildFeed({
      id: "tag:emdashcms.org,2026:feed:digest",
      title: "emdashcms.org — weekly digest",
      selfUrl: `${SITE_URL}/feeds/digest.xml`,
      alternateUrl: `${SITE_URL}/digest`,
      entries,
    });

    return new Response(xml, { status: 200, headers: FEED_HEADERS });
  } catch (err) {
    console.error("[feeds] digest.xml error:", err);
    return new Response("", {
      status: 500,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    });
  }
};
