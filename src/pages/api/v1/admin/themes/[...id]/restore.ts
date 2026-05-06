import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { setThemeStatus } from "../../../../../../lib/db/admin-queries";
import { errorResponse } from "../../../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const themeId = params.id;
  if (!themeId) return errorResponse(400, "Missing theme ID");

  const updated = await setThemeStatus(env.DB, themeId, "active");
  if (!updated) return errorResponse(404, "Theme not found");

  return new Response(JSON.stringify({ ok: true, status: "active" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
