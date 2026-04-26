import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { mergePlugins } from "../../../../../../lib/db/admin-queries";
import { resolveAuthorId } from "../../../../../../lib/publishing/plugin-queries";
import { errorResponse } from "../../../../../../lib/api/response";
import { emitRevokeNotification } from "../../../../../../lib/notifications/emitter";
import { purgeBadges } from "../../../../../../lib/badges/purge";

export const prerender = false;

/**
 * Collapse a duplicate plugin into its canonical sibling. The source
 * plugin row stays in D1 (keeping audit trail and inbound links alive)
 * but is hidden from listings via `merged_into IS NOT NULL`. Used to
 * clean up the resubmit-as-new pattern observed in production where an
 * author worked around an audit failure by registering identical
 * content under a fresh slug instead of uploading a new version
 * against the existing plugin.
 *
 * Mirrors the revoke endpoint's notification posture: the merge is
 * authoritative, notification emission is best-effort.
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const sourcePluginId = params.id;
  if (!sourcePluginId) return errorResponse(400, "Missing plugin ID");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const targetPluginId =
    typeof (body as Record<string, unknown>)?.targetPluginId === "string"
      ? ((body as Record<string, unknown>).targetPluginId as string).trim()
      : "";
  if (!targetPluginId) {
    return errorResponse(400, "Missing targetPluginId in request body");
  }

  const adminAuthorId = await resolveAuthorId(env.DB, author.githubId);
  if (!adminAuthorId) {
    // Admin has no authors row — extremely unusual but treat as auth
    // failure rather than crashing the endpoint.
    return errorResponse(403, "Admin author record not found");
  }

  // Read the plugin name BEFORE the merge so the notification body can
  // name both sides even if downstream UPDATEs change anything.
  const sourceRow = await env.DB.prepare(
    "SELECT name FROM plugins WHERE id = ?",
  )
    .bind(sourcePluginId)
    .first<{ name: string }>();

  const result = await mergePlugins(
    env.DB,
    sourcePluginId,
    targetPluginId,
    adminAuthorId,
  );
  if (!result.ok) {
    return errorResponse(400, result.error);
  }

  // Evict stale README badges for the merged-away plugin so any
  // existing embeds stop pointing at the now-hidden listing. Best-
  // effort — failures here must not break the response.
  try {
    await purgeBadges(new URL(request.url).origin, sourcePluginId);
  } catch (err) {
    console.error("[badges] purge after plugin merge failed:", err);
  }

  // Best-effort notification. Reuses the revoke template since the
  // visible-impact shape is the same: "this plugin is no longer
  // listable on the marketplace, here's why". Authoring a dedicated
  // template can come later if the merge volume warrants it.
  try {
    const eventId = `merge-plugin:${sourcePluginId}:${Date.now()}`;
    await emitRevokeNotification(env.DB, env.NOTIF_QUEUE, {
      eventId,
      scope: "plugin",
      entityType: "plugin",
      entityId: sourcePluginId,
      entityName: sourceRow?.name ?? sourcePluginId,
      reason: `Merged into ${targetPluginId} by a moderator. The original is now hidden from listings; future versions belong on ${targetPluginId}.`,
      publicNote: null,
    });
  } catch (notifyErr) {
    console.error("[notifications] merge-plugin emit failed:", notifyErr);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      merged: sourcePluginId,
      into: targetPluginId,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
