import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { jsonResponse, errorResponse } from "../../../../../../lib/api/response";
import { banAuthor } from "../../../../../../lib/db/report-queries";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const actor = locals.author;
  if (!actor || !isSuperAdmin(actor.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const authorId = params.id;
  if (!authorId) return errorResponse(400, "Missing author id");

  let body: { reason?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const reason = body.reason?.trim();
  if (!reason || reason.length < 5) {
    return errorResponse(
      400,
      "Ban reason must be at least 5 characters — required for accountability",
    );
  }

  const banned = await banAuthor(env.DB, authorId, reason);
  if (!banned) return errorResponse(404, "Author not found");

  return jsonResponse({ id: authorId, banned: true, reason });
};
