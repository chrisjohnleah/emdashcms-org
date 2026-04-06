import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { jsonResponse, errorResponse } from "../../../../../../lib/api/response";
import { unbanAuthor } from "../../../../../../lib/db/report-queries";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  const actor = locals.author;
  if (!actor || !isSuperAdmin(actor.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const authorId = params.id;
  if (!authorId) return errorResponse(400, "Missing author id");

  const unbanned = await unbanAuthor(env.DB, authorId);
  if (!unbanned) return errorResponse(404, "Author not found");

  return jsonResponse({ id: authorId, banned: false });
};
