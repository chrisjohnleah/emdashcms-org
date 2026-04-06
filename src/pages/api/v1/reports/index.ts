import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";
import {
  createReport,
  type ReportCategory,
  type ReportEntityType,
} from "../../../../lib/db/report-queries";
import { verifyTurnstile } from "../../../../lib/turnstile/verify";
import { resolveAuthorId } from "../../../../lib/publishing/plugin-queries";

export const prerender = false;

const VALID_ENTITY_TYPES: ReportEntityType[] = ["plugin", "theme"];
const VALID_CATEGORIES: ReportCategory[] = [
  "security",
  "abuse",
  "broken",
  "license",
  "other",
];

const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 2000;

export const POST: APIRoute = async ({ request, locals }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const entityType = body.entityType as string;
  const entityId = body.entityId as string;
  const category = body.reasonCategory as string;
  const description = body.description as string;
  const turnstileToken = body.turnstileToken as string | undefined;

  if (!VALID_ENTITY_TYPES.includes(entityType as ReportEntityType)) {
    return errorResponse(400, "entityType must be 'plugin' or 'theme'");
  }
  if (!entityId || typeof entityId !== "string") {
    return errorResponse(400, "entityId is required");
  }
  if (!VALID_CATEGORIES.includes(category as ReportCategory)) {
    return errorResponse(
      400,
      "reasonCategory must be one of: " + VALID_CATEGORIES.join(", "),
    );
  }
  if (
    typeof description !== "string" ||
    description.length < MIN_DESCRIPTION ||
    description.length > MAX_DESCRIPTION
  ) {
    return errorResponse(
      400,
      `description must be between ${MIN_DESCRIPTION} and ${MAX_DESCRIPTION} characters`,
    );
  }

  // Turnstile is required for anonymous reports. Authenticated users can
  // skip it since their session is already proof-of-personhood.
  if (!locals.author) {
    if (!turnstileToken) {
      return errorResponse(400, "Turnstile token required for anonymous reports");
    }
    const verify = await verifyTurnstile(
      turnstileToken,
      (env as unknown as { TURNSTILE_SECRET_KEY: string })
        .TURNSTILE_SECRET_KEY,
    );
    if (!verify.success) {
      return errorResponse(400, "Turnstile verification failed");
    }
  }

  // Verify the reported entity actually exists before storing the report.
  const existsTable = entityType === "plugin" ? "plugins" : "themes";
  const existsRow = await env.DB.prepare(
    `SELECT 1 AS found FROM ${existsTable} WHERE id = ?`,
  )
    .bind(entityId)
    .first();
  if (!existsRow) {
    return errorResponse(404, `${entityType} '${entityId}' not found`);
  }

  // Resolve reporter author id if authenticated.
  let reporterAuthorId: string | null = null;
  if (locals.author) {
    reporterAuthorId = await resolveAuthorId(env.DB, locals.author.githubId);
  }

  try {
    const id = await createReport(env.DB, {
      entityType: entityType as ReportEntityType,
      entityId,
      reporterAuthorId,
      reasonCategory: category as ReportCategory,
      description: description.trim(),
    });
    return jsonResponse({ id, status: "open" }, 202);
  } catch (err) {
    console.error("[api] Report creation error:", err);
    return errorResponse(500, "Internal server error");
  }
};
