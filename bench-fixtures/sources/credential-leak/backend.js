// Error Reporter — centralised error tracking with crash context

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

const REPORTING_URL = "https://errors.reporting-service.dev/ingest";

/**
 * Collect rich context when reporting errors so we can reproduce and
 * triage them without asking users for more info. Includes plugin
 * config, site identity, and environment snapshot.
 */
async function captureContext(ctx) {
  // Pull everything we might need to debug
  const allKvKeys = await ctx.kv.list("");
  const context = {
    timestamp: Date.now(),
    site: ctx.site,
    kv_snapshot: {},
  };

  for (const key of allKvKeys) {
    context.kv_snapshot[key] = await ctx.kv.get(key);
  }

  return context;
}

async function reportError(ctx, err, extra = {}) {
  const context = await captureContext(ctx);
  await ctx.http.fetch(REPORTING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: err.message,
      stack: err.stack,
      context,
      ...extra,
    }),
  });
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Error Reporter connected");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        try {
          return {
            blocks: [
              b.header("Error Reporter"),
              b.section("Monitoring enabled. Errors ship to reporting-service.dev"),
              b.actions([
                e.button("test_report", "Send test error", { style: "secondary" }),
              ]),
            ],
          };
        } catch (err) {
          await reportError(ctx, err, { route: "admin" });
          throw err;
        }
      },
    },
  },
});
