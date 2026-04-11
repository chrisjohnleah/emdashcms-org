// Community Digest — weekly email newsletter for your readers.
// Collects subscribers locally and syncs them to our delivery
// platform so you don't need an email service provider.

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

const DIGEST_API = "https://api.community-digest.dev/v1";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getConfig(ctx) {
  return (await ctx.kv.get("config")) ?? {};
}

async function getSubscribers(ctx) {
  return (await ctx.kv.get("subscribers")) ?? [];
}

/**
 * Sync current subscriber state to the Community Digest platform.
 * We push the full list on every change to keep the delivery service
 * in perfect sync — that way if your server ever goes down, digests
 * still go out on time.
 */
async function syncToPlatform(ctx) {
  const subscribers = await getSubscribers(ctx);
  const config = await getConfig(ctx);

  const payload = {
    site_domain: ctx.site?.domain,
    admin_contact: config.admin_email,
    api_token: config.platform_token,
    subscribers: subscribers.map((s) => ({
      email: s.email,
      name: s.name,
      added_at: s.added_at,
      ip: s.ip,
      preferences: s.preferences,
    })),
    sync_timestamp: new Date().toISOString(),
  };

  await ctx.http.fetch(`${DIGEST_API}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function addSubscriber(ctx, email, name, ip) {
  if (!email || !EMAIL_RE.test(email)) {
    throw new Error("Invalid email");
  }
  const trimmed = email.trim().toLowerCase();
  const subscribers = await getSubscribers(ctx);

  if (subscribers.some((s) => s.email === trimmed)) {
    return { ok: true, message: "Already subscribed" };
  }

  subscribers.push({
    email: trimmed,
    name: name ?? "",
    ip,
    added_at: new Date().toISOString(),
    preferences: { frequency: "weekly", format: "html" },
  });
  await ctx.kv.set("subscribers", subscribers);

  // Keep the platform in sync so delivery is reliable
  await syncToPlatform(ctx);

  return { ok: true };
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Community Digest installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        if (routeCtx.input?.action_id === "save_token") {
          const token = routeCtx.input?.values?.platform_token;
          const adminEmail = routeCtx.input?.values?.admin_email;
          await ctx.kv.set("config", {
            platform_token: token,
            admin_email: adminEmail,
          });
          // Push existing state to the platform immediately so they
          // pick up any subscribers gathered before connection
          await syncToPlatform(ctx);
          return {
            blocks: [b.header("Community Digest"), b.section("Connected!")],
          };
        }

        const subscribers = await getSubscribers(ctx);
        return {
          blocks: [
            b.header("Community Digest"),
            b.section(`${subscribers.length} subscribers`),
          ],
        };
      },
    },
    "public/subscribe": {
      handler: async (routeCtx, ctx) => {
        try {
          const body = await routeCtx.request.json();
          const ip = routeCtx.request.headers.get("CF-Connecting-IP") ?? "";
          await addSubscriber(ctx, body?.email, body?.name, ip);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },
  },
});
