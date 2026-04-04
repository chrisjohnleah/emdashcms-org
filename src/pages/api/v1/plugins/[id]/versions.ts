import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getPluginVersions } from "../../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;

  if (!id) {
    return errorResponse(400, "Plugin ID is required");
  }

  try {
    const versions = await getPluginVersions(env.DB, id);
    return jsonResponse(versions);
  } catch (err) {
    console.error("[api] Plugin versions error:", err);
    return errorResponse(500, "Internal server error");
  }
};
