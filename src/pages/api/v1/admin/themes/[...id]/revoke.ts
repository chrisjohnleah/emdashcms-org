import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { setThemeStatus } from "../../../../../../lib/db/admin-queries";
import { errorResponse } from "../../../../../../lib/api/response";
import { emitRevokeNotification } from "../../../../../../lib/notifications/emitter";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const themeId = params.id;
  if (!themeId) return errorResponse(400, "Missing theme ID");

  const nameRow = await env.DB.prepare("SELECT name FROM themes WHERE id = ?")
    .bind(themeId)
    .first<{ name: string }>();

  const updated = await setThemeStatus(env.DB, themeId, "revoked");
  if (!updated) return errorResponse(404, "Theme not found");

  try {
    const revokeEventId = `revoke-theme:${themeId}:${Date.now()}`;
    await emitRevokeNotification(env.DB, env.NOTIF_QUEUE, {
      eventId: revokeEventId,
      scope: "plugin",
      entityType: "theme",
      entityId: themeId,
      entityName: nameRow?.name ?? themeId,
      reason: "Theme revoked by moderator",
      publicNote: null,
    });
  } catch (notifyErr) {
    console.error("[notifications] revoke-theme emit failed:", notifyErr);
  }

  return new Response(JSON.stringify({ ok: true, status: "revoked" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
