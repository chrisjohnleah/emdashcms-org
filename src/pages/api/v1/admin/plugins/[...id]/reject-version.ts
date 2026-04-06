import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import {
  jsonResponse,
  errorResponse,
} from "../../../../../../lib/api/response";

export const prerender = false;

/**
 * Admin action: reject a pending or flagged plugin version. Used by the
 * moderation queue to refuse versions that the admin has manually
 * reviewed and decided not to publish.
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

    await env.DB.prepare(
      `UPDATE plugin_versions
       SET status = 'rejected',
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
      .bind(row.id)
      .run();

    // Persist the rejection reason as an audit record so the publisher
    // (and future admins) can see why it was refused. The public_note
    // flag controls whether the reason surfaces on the plugin detail page.
    if (reason) {
      await env.DB.prepare(
        `INSERT INTO plugin_audits (
          id, plugin_version_id, status, model, prompt_tokens, completion_tokens,
          neurons_used, raw_response, verdict, risk_score, findings, public_note, created_at
        ) VALUES (?, ?, 'complete', 'admin-action', 0, 0, 0, ?, 'fail', 100, '[]', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
        .bind(
          crypto.randomUUID(),
          row.id,
          `Manually rejected by admin: ${reason}`,
          publicNote ? 1 : 0,
        )
        .run();
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
