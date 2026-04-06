import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { jsonResponse, errorResponse } from "../../../../../../lib/api/response";
import {
  updateReportStatus,
  type ReportStatus,
} from "../../../../../../lib/db/report-queries";
import { resolveAuthorId } from "../../../../../../lib/publishing/plugin-queries";

export const prerender = false;

const VALID_STATUSES: ReportStatus[] = [
  "open",
  "investigating",
  "resolved",
  "dismissed",
];

export const POST: APIRoute = async ({ params, request, locals }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const reportId = params.id;
  if (!reportId) return errorResponse(400, "Missing report id");

  let body: { status?: string; resolutionNote?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!VALID_STATUSES.includes(body.status as ReportStatus)) {
    return errorResponse(
      400,
      "status must be one of: " + VALID_STATUSES.join(", "),
    );
  }

  const resolverId = await resolveAuthorId(env.DB, author.githubId);
  const updated = await updateReportStatus(
    env.DB,
    reportId,
    body.status as ReportStatus,
    body.resolutionNote?.trim() || null,
    resolverId,
  );

  if (!updated) return errorResponse(404, "Report not found");

  return jsonResponse({ id: reportId, status: body.status });
};
