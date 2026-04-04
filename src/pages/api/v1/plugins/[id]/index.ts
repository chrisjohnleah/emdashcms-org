import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getPluginDetail } from "../../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;

  if (!id) {
    return errorResponse(400, "Plugin ID is required");
  }

  try {
    const plugin = await getPluginDetail(env.DB, id);

    if (!plugin) {
      return errorResponse(404, "Plugin not found");
    }

    return jsonResponse(plugin);
  } catch (err) {
    console.error("[api] Plugin detail error:", err);
    return errorResponse(500, "Internal server error");
  }
};
