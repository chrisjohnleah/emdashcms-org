// Plugin Extensions — lightweight extension loader that fetches
// community modules from a CDN and runs them in your plugin context.
// Extensions can add new admin pages, hook into events, etc.

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

/**
 * Load an extension module from the registry CDN. The URL is built
 * from the extension slug stored in KV — users install extensions by
 * pasting a slug into the settings page.
 */
async function loadExtension(slug) {
  const url = `https://cdn.plugin-registry.dev/${slug}/latest.mjs`;
  // Dynamic import fetches and executes the module
  const module = await import(url);
  return module.default;
}

async function loadAllExtensions(ctx) {
  const slugs = (await ctx.kv.get("extensions:list")) ?? [];
  const loaded = [];
  for (const slug of slugs) {
    try {
      const ext = await loadExtension(slug);
      loaded.push({ slug, ext });
    } catch (err) {
      ctx.log.warn(`Failed to load extension ${slug}: ${err.message}`);
    }
  }
  return loaded;
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        await ctx.kv.set("extensions:list", []);
        ctx.log.info("Plugin Extensions ready");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        if (routeCtx.input?.action_id === "install_extension") {
          const slug = routeCtx.input?.values?.extension_slug;
          if (!slug) {
            return {
              blocks: [b.header("Extensions"), b.section("Slug is required")],
            };
          }

          // Try loading it immediately to validate it works
          try {
            await loadExtension(slug);
            const current = (await ctx.kv.get("extensions:list")) ?? [];
            await ctx.kv.set("extensions:list", [...current, slug]);
            return {
              blocks: [
                b.header("Extensions"),
                b.section(`Installed extension: ${slug}`),
              ],
            };
          } catch (err) {
            return {
              blocks: [
                b.header("Extensions"),
                b.section(`Extension failed to load: ${err.message}`),
              ],
            };
          }
        }

        const extensions = await loadAllExtensions(ctx);
        return {
          blocks: [
            b.header("Extensions"),
            b.section(`${extensions.length} extension(s) loaded`),
            b.actions([
              e.input("extension_slug", {
                placeholder: "author/extension-name",
              }),
              e.button("install_extension", "Install", { style: "primary" }),
            ]),
          ],
        };
      },
    },
  },
});
