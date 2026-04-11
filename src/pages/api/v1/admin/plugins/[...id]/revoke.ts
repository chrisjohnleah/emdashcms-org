import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { setPluginStatus } from "../../../../../../lib/db/admin-queries";
import { errorResponse } from "../../../../../../lib/api/response";
import { emitRevokeNotification } from "../../../../../../lib/notifications/emitter";
import { purgeBadges } from "../../../../../../lib/badges/purge";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  // Read the plugin name BEFORE the status change so the notification
  // body can name the listing even if a downstream UPDATE wipes the row.
  const nameRow = await env.DB.prepare(
    "SELECT name FROM plugins WHERE id = ?",
  )
    .bind(pluginId)
    .first<{ name: string }>();

  const updated = await setPluginStatus(env.DB, pluginId, "revoked");
  if (!updated) return errorResponse(404, "Plugin not found");

  // Evict stale README badges for this plugin. Best-effort per D-15:
  // a purge failure must not break the revoke — the plugin row is
  // already flipped to `revoked` in D1 at this point.
  try {
    await purgeBadges(new URL(request.url).origin, pluginId);
  } catch (err) {
    console.error("[badges] purge after plugin revoke failed:", err);
  }

  // Best-effort notification emission. The plugin is already revoked at
  // this point — failures here MUST NOT break the response. Note: this
  // route does not currently accept a `reason` body field (unlike
  // revoke-version), so we use a placeholder. Christopher to consider
  // extending the route shape in a follow-up.
  try {
    const revokeEventId = `revoke-plugin:${pluginId}:${Date.now()}`;
    await emitRevokeNotification(env.DB, env.NOTIF_QUEUE, {
      eventId: revokeEventId,
      scope: "plugin",
      entityType: "plugin",
      entityId: pluginId,
      entityName: nameRow?.name ?? pluginId,
      reason: "Plugin revoked by moderator",
      publicNote: null,
    });
  } catch (notifyErr) {
    console.error("[notifications] revoke-plugin emit failed:", notifyErr);
  }

  return new Response(JSON.stringify({ ok: true, status: "revoked" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
