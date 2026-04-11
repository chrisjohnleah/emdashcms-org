import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { setPluginStatus } from "../../../../../../lib/db/admin-queries";
import { errorResponse } from "../../../../../../lib/api/response";
import { purgeBadges } from "../../../../../../lib/badges/purge";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  const updated = await setPluginStatus(env.DB, pluginId, "active");
  if (!updated) return errorResponse(404, "Plugin not found");

  // Evict stale README badges so the next render rebuilds with the
  // post-restore state (no more "revoked" styling). Best-effort per
  // D-15 — the plugin is already restored in D1 at this point.
  try {
    await purgeBadges(new URL(request.url).origin, pluginId);
  } catch (err) {
    console.error("[badges] purge after plugin restore failed:", err);
  }

  return new Response(JSON.stringify({ ok: true, status: "active" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
