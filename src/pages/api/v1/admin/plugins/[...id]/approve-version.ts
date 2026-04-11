import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import {
  jsonResponse,
  errorResponse,
} from "../../../../../../lib/api/response";
import { createAuditRecord } from "../../../../../../lib/audit/audit-queries";
import { emitAuditNotification } from "../../../../../../lib/notifications/emitter";
import { purgeBadges } from "../../../../../../lib/badges/purge";

export const prerender = false;

/**
 * Admin action: approve a pending plugin version, moving it to 'published'
 * and stamping published_at. Used by the moderation queue to manually
 * publish versions that AUDIT_MODE='manual' left for human review.
 *
 * Writes an `admin-action` audit row via createAuditRecord so the
 * approval is recorded in audit history AND the publisher receives an
 * `audit_pass` notification with a stable eventId for idempotency.
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  let version: string;
  try {
    const body = await request.json();
    version = (body as { version: string }).version;
  } catch {
    return errorResponse(400, "Request body must include { version }");
  }

  if (!version) return errorResponse(400, "Missing version");

  try {
    const row = await env.DB.prepare(
      "SELECT id, status FROM plugin_versions WHERE plugin_id = ? AND version = ?",
    )
      .bind(pluginId, version)
      .first<{ id: string; status: string }>();

    if (!row) return errorResponse(404, "Version not found");

    // Allowed transitions: pending → published, flagged → published.
    // Rejected versions need a re-audit, not a direct approve.
    if (row.status !== "pending" && row.status !== "flagged") {
      return errorResponse(
        409,
        `Cannot approve a version in status '${row.status}' — only pending or flagged`,
      );
    }

    // createAuditRecord writes the audit row AND flips version status to
    // 'published' (via verdictToStatus(pass)) in a single batch, including
    // the published_at stamp. The returned auditId is reused as the
    // notification eventId so a queue retry dedupes against the audit row.
    const auditId = await createAuditRecord(env.DB, {
      versionId: row.id,
      status: "complete",
      model: "admin-action",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: "Manually approved by admin",
      verdict: "pass",
      riskScore: 0,
      findings: [],
    });

    // Evict stale README badges for this plugin from the edge cache so
    // the next badge request rebuilds with the just-approved version
    // and trust tier. Best-effort per D-15: a purge failure must not
    // fail the parent request — the version is already approved.
    try {
      await purgeBadges(new URL(request.url).origin, pluginId);
    } catch (err) {
      console.error("[badges] purge after approve-version failed:", err);
    }

    // Emit the audit_pass notification. Wrapped in try/catch so a broken
    // notification pipeline cannot break the approve flow — the version
    // is already published at this point and the response must succeed.
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
        verdict: "pass",
        riskScore: 0,
        findingCount: 0,
      });
    } catch (notifyErr) {
      console.error("[notifications] approve-version emit failed:", notifyErr);
    }

    return jsonResponse(
      {
        version,
        status: "published",
        message: "Version approved by admin",
      },
      200,
    );
  } catch (err) {
    console.error("[admin] Approve version error:", err);
    return errorResponse(500, "Internal server error");
  }
};
