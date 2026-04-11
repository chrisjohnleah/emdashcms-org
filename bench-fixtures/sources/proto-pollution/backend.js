// Form Builder — create custom forms with dynamic field configuration
// Merges user-submitted field config into form definitions

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

/**
 * Deep-merge user config into the target object. Used to let form
 * authors override default field behaviour with a partial spec.
 */
function deepMerge(target, source) {
  for (const key in source) {
    if (typeof source[key] === "object" && source[key] !== null) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const DEFAULT_FIELD = {
  type: "text",
  required: false,
  maxLength: 255,
};

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Form Builder installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        if (routeCtx.input?.action_id === "save_form") {
          const rawConfig = routeCtx.input?.values?.field_config;
          const userConfig = JSON.parse(rawConfig ?? "{}");

          // Merge user overrides into the default field spec so each
          // form gets the standard base with the user's customisations
          // layered on top
          const merged = deepMerge({ ...DEFAULT_FIELD }, userConfig);

          await ctx.kv.set(`forms:${routeCtx.input.values.form_name}`, merged);

          return {
            blocks: [
              b.header("Form Builder"),
              b.section(`Form saved with ${Object.keys(merged).length} fields`),
            ],
          };
        }

        return {
          blocks: [
            b.header("Form Builder"),
            b.section("Define your form fields as JSON"),
            b.actions([
              e.input("form_name", { placeholder: "contact-form" }),
              e.input("field_config", {
                placeholder: '{"email": {"type": "email", "required": true}}',
                multiline: true,
              }),
              e.button("save_form", "Save", { style: "primary" }),
            ]),
          ],
        };
      },
    },
    "public/submit": {
      handler: async (routeCtx, ctx) => {
        const body = await routeCtx.request.json();
        await ctx.kv.set(`submissions:${Date.now()}`, body);
        return { ok: true };
      },
    },
  },
});
