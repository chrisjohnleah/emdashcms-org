import type { APIRoute } from "astro";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const author = locals.author;

  if (!author) {
    return errorResponse(401, "Authentication required");
  }

  return jsonResponse({
    id: author.id,
    githubId: author.githubId,
    username: author.username,
  });
};
