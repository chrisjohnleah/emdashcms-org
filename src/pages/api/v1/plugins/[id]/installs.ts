import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  trackInstall,
  pluginExists,
} from "../../../../../lib/downloads/queries";
import { errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async ({ params, request }) => {
  const { id: pluginId } = params;

  if (!pluginId) {
    return errorResponse(400, "Plugin ID is required");
  }

  try {
    let body: { siteHash?: string; version?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "Invalid JSON body");
    }

    if (!body.siteHash || typeof body.siteHash !== "string") {
      return errorResponse(400, "siteHash is required and must be a string");
    }
    if (!body.version || typeof body.version !== "string") {
      return errorResponse(400, "version is required and must be a string");
    }

    const exists = await pluginExists(env.DB, pluginId);
    if (!exists) {
      return errorResponse(404, "Plugin not found");
    }

    await trackInstall(env.DB, pluginId, body.siteHash, body.version);

    return new Response(null, { status: 202 });
  } catch (err) {
    console.error("[api] Install tracking error:", err);
    return errorResponse(500, "Internal server error");
  }
};
