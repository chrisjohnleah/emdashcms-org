import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import {
  jsonResponse,
  errorResponse,
} from "../../../../../../lib/api/response";
import { createAuditRecord } from "../../../../../../lib/audit/audit-queries";
import { emitAuditNotification } from "../../../../../../lib/notifications/emitter";

export const prerender = false;

/**
 * Admin action: reject a pending or flagged plugin version. Used by the
 * moderation queue to refuse versions that the admin has manually
 * reviewed and decided not to publish.
 *
 * Writes an `admin-action` audit row via createAuditRecord — this both
 * records the rejection in audit history (with the optional reason and
 * public_note flag) AND yields a stable auditId reused as the
 * notification eventId for idempotency.
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  let version: string;
  let reason: string | undefined;
  let publicNote: boolean;
  try {
    const body = (await request.json()) as {
      version: string;
      reason?: string;
      publicNote?: boolean;
    };
    version = body.version;
    reason = body.reason;
    // Default to public — transparency is the policy. Admin can uncheck
    // the box for notes referencing out-of-band context.
    publicNote = body.publicNote !== false;
  } catch {
    return errorResponse(400, "Request body must include { version, reason? }");
  }

  if (!version) return errorResponse(400, "Missing version");
  if (reason && reason.length > 500) {
    return errorResponse(400, "Reason must be 500 characters or less");
  }

  try {
    const row = await env.DB.prepare(
      "SELECT id, status FROM plugin_versions WHERE plugin_id = ? AND version = ?",
    )
      .bind(pluginId, version)
      .first<{ id: string; status: string }>();

    if (!row) return errorResponse(404, "Version not found");
    if (row.status === "rejected") {
      return errorResponse(409, "Version is already rejected");
    }

    // createAuditRecord writes the audit row AND flips version status to
    // 'rejected' (via verdictToStatus(fail)) in a single batch. publicNote
    // controls whether the rejection reason surfaces on the plugin detail
    // page; the column is stored either way.
    const auditId = await createAuditRecord(env.DB, {
      versionId: row.id,
      status: "complete",
      model: "admin-action",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: reason
        ? `Manually rejected by admin: ${reason}`
        : "Manually rejected by admin",
      verdict: "fail",
      riskScore: 100,
      findings: [],
      publicNote,
    });

    // Emit the audit_fail notification. Wrapped in try/catch so a broken
    // notification pipeline cannot break the reject flow — the version
    // is already rejected at this point and the response must succeed.
    try {
      const nameRow = await env.DB.prepare(
        "SELECT name FROM plugins WHERE id = ?",
      )
        .bind(pluginId)
        .first<{ name: string }>();
      await emitAuditNotification(env.DB, env.NOTIF_QUEUE, {
        auditId,
        pluginId,
        pluginName: nameRow?.name ?? pluginId,
        version,
        verdict: "fail",
        riskScore: 100,
        findingCount: 0,
        errorMessage: reason,
      });
    } catch (notifyErr) {
      console.error("[notifications] reject-version emit failed:", notifyErr);
    }

    return jsonResponse(
      {
        version,
        status: "rejected",
        message: "Version rejected by admin",
      },
      200,
    );
  } catch (err) {
    console.error("[admin] Reject version error:", err);
    return errorResponse(500, "Internal server error");
  }
};
