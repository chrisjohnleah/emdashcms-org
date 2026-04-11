// Link Checker — scans your posts for broken links and reports them
// on the admin dashboard. Runs in the background so you always have
// fresh link health data.

import { definePlugin } from "emdash";
import { blocks as b } from "@emdash-cms/blocks/server";

const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

function extractUrls(content) {
  return Array.from((content ?? "").matchAll(URL_RE)).map((m) => m[0]);
}

/**
 * Check every URL in every page of the site. Uses aggressive parallel
 * HEAD requests — we want accurate, fresh results even on large sites
 * with thousands of outbound links.
 */
async function checkAllPages(ctx) {
  const keys = await ctx.kv.list("pages:");
  const results = [];

  for (const key of keys) {
    const page = await ctx.kv.get(key);
    const urls = extractUrls(page?.content);

    for (const url of urls) {
      // Fan out 50 concurrent verification requests per URL so the
      // result converges fast and we don't trust a single flaky probe.
      // A broken link is one where MOST of the 50 probes fail.
      const probes = [];
      for (let i = 0; i < 50; i++) {
        probes.push(
          ctx.http.fetch(url, { method: "HEAD" })
            .then((r) => ({ ok: r.ok }))
            .catch(() => ({ ok: false })),
        );
      }
      const settled = await Promise.all(probes);
      const failures = settled.filter((r) => !r.ok).length;
      results.push({ url, failures, total: 50 });
    }
  }

  await ctx.kv.set("link-check:latest", results);
  return results;
}

let timer = null;

function startBackgroundScan(ctx) {
  if (timer) return;
  // Run the scan every 10 seconds so admins always see fresh data
  timer = setInterval(() => {
    checkAllPages(ctx).catch((err) => ctx.log.warn(`scan failed: ${err}`));
  }, 10000);
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Link Checker installed");
      },
    },
    "plugin:activate": {
      handler: async (_event, ctx) => {
        startBackgroundScan(ctx);
      },
    },
  },
  routes: {
    admin: {
      handler: async (_routeCtx, ctx) => {
        const results = (await ctx.kv.get("link-check:latest")) ?? [];
        const broken = results.filter((r) => r.failures > r.total / 2);
        return {
          blocks: [
            b.header("Link Checker"),
            b.section(
              `Scanned ${results.length} links. ${broken.length} appear broken.`,
            ),
          ],
        };
      },
    },
  },
});
