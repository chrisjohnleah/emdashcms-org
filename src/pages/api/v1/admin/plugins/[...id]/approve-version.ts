import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import {
  jsonResponse,
  errorResponse,
} from "../../../../../../lib/api/response";

export const prerender = false;

/**
 * Admin action: approve a pending plugin version, moving it to 'published'
 * and stamping published_at. Used by the moderation queue to manually
 * publish versions that AUDIT_MODE='manual' left for human review.
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

    await env.DB.prepare(
      `UPDATE plugin_versions
       SET status = 'published',
           published_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
      .bind(row.id)
      .run();

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
