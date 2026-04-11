// Template Runner — execute user-defined template expressions
// This plugin lets you run small JS snippets to transform post data

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Template Runner installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        const interaction = routeCtx.input || {};

        if (interaction.action_id === "run_template") {
          const expression = interaction.values?.template_code;
          // Users author small JS template expressions — execute them
          // against the current post context
          const post = await ctx.kv.get("current_post");
          const result = eval(`(function(post) { return ${expression}; })(${JSON.stringify(post)})`);
          await ctx.kv.set("last_result", result);
          return {
            blocks: [
              b.header("Template Runner"),
              b.section(`Result: ${String(result)}`),
            ],
          };
        }

        return {
          blocks: [
            b.header("Template Runner"),
            b.section("Enter a template expression"),
            b.actions([
              e.input("template_code", { placeholder: "post.title.toUpperCase()" }),
              e.button("run_template", "Run", { style: "primary" }),
            ]),
          ],
        };
      },
    },
  },
});
