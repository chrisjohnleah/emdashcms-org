// Newsletter Sync — two-way sync between your EmDash site and a
// newsletter platform. Declares network:fetch with the platform host
// in allowedHosts.

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

const API_BASE = "https://api.newsletter-platform.com/v2";

class NewsletterApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function apiCall(ctx, path, options = {}) {
  const token = await ctx.kv.get("config:apiToken");
  if (!token) {
    throw new NewsletterApiError("API token not configured", 401);
  }
  const response = await ctx.http.fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new NewsletterApiError(
      `API ${response.status}: ${body.slice(0, 200)}`,
      response.status,
    );
  }
  return response.json();
}

async function listSubscribers(ctx, params = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiCall(ctx, `/subscribers${qs ? "?" + qs : ""}`);
}

async function addSubscriber(ctx, email, metadata = {}) {
  if (!email || typeof email !== "string") {
    throw new NewsletterApiError("Email is required", 400);
  }
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new NewsletterApiError("Invalid email format", 400);
  }
  return apiCall(ctx, "/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email: trimmed,
      metadata: {
        source: "emdash-plugin",
        ...metadata,
      },
    }),
  });
}

function errorScreen(err) {
  const message =
    err instanceof NewsletterApiError
      ? err.status === 401
        ? "Invalid API token. Update it in settings."
        : err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    blocks: [b.header("Newsletter Sync"), b.section(message)],
  };
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Newsletter Sync installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        try {
          if (routeCtx.input?.action_id === "save_token") {
            const token = routeCtx.input?.values?.api_token?.trim();
            if (!token || !token.startsWith("np_")) {
              return errorScreen(new NewsletterApiError("Invalid token format", 400));
            }
            await ctx.kv.set("config:apiToken", token);
            return {
              blocks: [
                b.header("Newsletter Sync"),
                b.section("Token saved. Ready to sync."),
              ],
              toast: { message: "Connected", type: "success" },
            };
          }

          const token = await ctx.kv.get("config:apiToken");
          if (!token) {
            return {
              blocks: [
                b.header("Newsletter Sync"),
                b.section("Enter your API token to get started"),
                b.actions([
                  e.input("api_token", { placeholder: "np_..." }),
                  e.button("save_token", "Connect", { style: "primary" }),
                ]),
              ],
            };
          }

          const { data: subscribers } = await listSubscribers(ctx, { limit: 10 });
          return {
            blocks: [
              b.header("Newsletter Sync"),
              b.section(`${subscribers?.length ?? 0} subscribers synced`),
            ],
          };
        } catch (err) {
          return errorScreen(err);
        }
      },
    },
    "public/subscribe": {
      handler: async (routeCtx, ctx) => {
        try {
          const body = await routeCtx.request.json();
          await addSubscriber(ctx, body?.email, { signup_url: body?.source });
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : "Unknown error",
          };
        }
      },
    },
  },
});
