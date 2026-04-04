import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getThemeDetail } from "../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;

  if (!id) {
    return errorResponse(400, "Theme ID is required");
  }

  try {
    const theme = await getThemeDetail(env.DB, id);

    if (!theme) {
      return errorResponse(404, "Theme not found");
    }

    return jsonResponse(theme);
  } catch (err) {
    console.error("[api] Theme detail error:", err);
    return errorResponse(500, "Internal server error");
  }
};
