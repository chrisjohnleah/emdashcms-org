import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { jsonResponse, errorResponse } from "../../../../../../lib/api/response";
import { createAuditRecord } from "../../../../../../lib/audit/audit-queries";

export const prerender = false;

/**
 * Revoke a single published or flagged version.
 *
 * Unlike POST /revoke (which revokes the entire plugin), this endpoint
 * targets a specific version — e.g. when a previously clean plugin
 * ships a malicious update and we want to block just that version
 * while leaving earlier good versions downloadable.
 *
 * Writes an admin-action audit record with the reason so the author
 * sees it on their dashboard and (if public_note is set via B5) on
 * the public detail page.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  let body: { version?: string; reason?: string; publicNote?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse(400, "Request body must include { version, reason }");
  }

  const version = body.version;
  const reason = body.reason?.trim();
  // Default to public — transparency is the policy.
  const publicNote = body.publicNote !== false;
  if (!version) return errorResponse(400, "Missing version");
  if (!reason || reason.length < 5) {
    return errorResponse(
      400,
      "A revocation reason is required (min 5 chars) — it's surfaced to the author and, when marked public, to installers.",
    );
  }

  try {
    const row = await env.DB.prepare(
      "SELECT id, status FROM plugin_versions WHERE plugin_id = ? AND version = ?",
    )
      .bind(pluginId, version)
      .first<{ id: string; status: string }>();

    if (!row) return errorResponse(404, "Version not found");

    // Only published/flagged versions can be revoked. pending/rejected
    // have their own lifecycles.
    if (row.status !== "published" && row.status !== "flagged") {
      return errorResponse(
        409,
        `Cannot revoke a version in status '${row.status}' — only published or flagged versions can be revoked`,
      );
    }

    // Write an admin-action audit record AND flip the version status in
    // one atomic batch via createAuditRecord's versionStatusOverride.
    await createAuditRecord(env.DB, {
      versionId: row.id,
      status: "complete",
      model: "admin-action",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: reason,
      verdict: null,
      riskScore: 0,
      findings: [],
      versionStatusOverride: "revoked",
      publicNote,
    });

    return jsonResponse(
      {
        pluginId,
        version,
        status: "revoked",
        message: "Version revoked — downloads are now blocked.",
      },
      200,
    );
  } catch (err) {
    console.error("[admin] Revoke version error:", err);
    return errorResponse(500, "Internal server error");
  }
};
