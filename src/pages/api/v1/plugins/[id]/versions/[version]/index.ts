import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, errorResponse } from "../../../../../../../lib/api/response";

export const prerender = false;

/**
 * Single-version status lookup, polled by the upstream `emdash` CLI
 * after a successful upload to surface the audit verdict.
 *
 * Public read — version status is the same information shown on the
 * plugin's public detail page, so no Bearer required even though the
 * CLI sends one. The shape mixes snake_case (audit_verdict,
 * image_audit_verdict) and camelCase (bundleSize) because that's how
 * the CLI reads them in `displayAuditResults`.
 */
export const GET: APIRoute = async ({ params }) => {
  const pluginId = params.id;
  const version = params.version;
  if (!pluginId) return errorResponse(400, "Plugin ID is required");
  if (!version) return errorResponse(400, "Version is required");

  try {
    const row = await env.DB.prepare(
      `SELECT pv.version, pv.status, pv.checksum, pv.compressed_size, pa.verdict
         FROM plugin_versions pv
         LEFT JOIN plugin_audits pa
           ON pa.plugin_version_id = pv.id
          AND pa.created_at = (
            SELECT MAX(pa2.created_at)
              FROM plugin_audits pa2
             WHERE pa2.plugin_version_id = pv.id
          )
        WHERE pv.plugin_id = ? AND pv.version = ?`,
    )
      .bind(pluginId, version)
      .first<{
        version: string;
        status: string;
        checksum: string | null;
        compressed_size: number | null;
        verdict: "pass" | "warn" | "fail" | null;
      }>();

    if (!row) return errorResponse(404, "Version not found");

    return jsonResponse({
      version: row.version,
      status: row.status,
      audit_verdict: row.verdict ?? null,
      // No image audit pipeline in v1 — surface explicit null so the
      // CLI's display logic skips the section rather than rendering
      // "undefined".
      image_audit_verdict: null,
      checksum: row.checksum ?? "",
      bundleSize: row.compressed_size ?? 0,
    });
  } catch (err) {
    console.error("[api] Version status lookup error:", err);
    return errorResponse(500, "Internal server error");
  }
};
