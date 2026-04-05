import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../lib/auth/admin";
import { deleteReview } from "../../../../../lib/db/review-queries";
import { errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

export const DELETE: APIRoute = async ({ params, locals }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const reviewId = params.id;
  if (!reviewId) return errorResponse(400, "Missing review ID");

  const deleted = await deleteReview(env.DB, reviewId);
  if (!deleted) return errorResponse(404, "Review not found");

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
