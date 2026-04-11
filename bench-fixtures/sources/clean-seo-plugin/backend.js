// SEO Meta Tags — manage per-post meta tags for search engines
// Stores settings locally, no network, no user-input execution

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

function validateTitle(title) {
  if (!title || typeof title !== "string") return "Title is required";
  if (title.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or less`;
  return null;
}

function validateDescription(desc) {
  if (!desc || typeof desc !== "string") return "Description is required";
  if (desc.length > DESCRIPTION_MAX) return `Description must be ${DESCRIPTION_MAX} characters or less`;
  return null;
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        const defaults = {
          titleSuffix: "",
          defaultDescription: "",
          twitterHandle: "",
        };
        await ctx.kv.set("settings", defaults);
        ctx.log.info("SEO Meta Tags installed with default settings");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        const settings = (await ctx.kv.get("settings")) || {};

        if (routeCtx.input?.action_id === "save_settings") {
          const values = routeCtx.input?.values ?? {};
          const titleError = validateTitle(values.title_suffix);
          const descError = validateDescription(values.default_description);

          if (titleError || descError) {
            return {
              blocks: [
                b.header("SEO Meta Tags"),
                b.section(titleError || descError || "Validation error"),
              ],
              toast: { message: "Fix errors and retry", type: "error" },
            };
          }

          const updated = {
            titleSuffix: values.title_suffix,
            defaultDescription: values.default_description,
            twitterHandle: (values.twitter_handle ?? "").replace(/^@/, ""),
          };
          await ctx.kv.set("settings", updated);

          return {
            blocks: [
              b.header("SEO Meta Tags"),
              b.section("Settings saved"),
            ],
            toast: { message: "Saved", type: "success" },
          };
        }

        return {
          blocks: [
            b.header("SEO Meta Tags"),
            b.section("Configure default meta tag values for all posts"),
            b.form([
              e.input("title_suffix", {
                label: "Title suffix",
                value: settings.titleSuffix ?? "",
                placeholder: "| Your Site",
              }),
              e.input("default_description", {
                label: "Default description",
                value: settings.defaultDescription ?? "",
                multiline: true,
              }),
              e.input("twitter_handle", {
                label: "Twitter handle",
                value: settings.twitterHandle ?? "",
                placeholder: "yourhandle",
              }),
              e.button("save_settings", "Save settings", { style: "primary" }),
            ]),
          ],
        };
      },
    },
  },
});
