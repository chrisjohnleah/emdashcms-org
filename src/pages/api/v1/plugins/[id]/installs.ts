import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  trackInstall,
  pluginExists,
} from "../../../../../lib/downloads/queries";
import { errorResponse } from "../../../../../lib/api/response";
import { checkRateLimit } from "../../../../../lib/downloads/rate-limit";
import { getDeprecationWarning } from "../../../../../lib/publishing/deprecation-queries";

export const prerender = false;

/** SHA-256 hex format: exactly 64 lowercase hex characters. */
const SITE_HASH_REGEX = /^[a-f0-9]{64}$/;

/** Semver-ish: digits and dots, 1-20 chars. */
const VERSION_REGEX = /^[a-z0-9][a-z0-9.\-]{0,19}$/;

export const POST: APIRoute = async ({ params, request }) => {
  const { id: pluginId } = params;

  if (!pluginId) {
    return errorResponse(400, "Plugin ID is required");
  }

  // Per-IP rate limit: 10 installs per minute
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed } = await checkRateLimit(env.DB, `install:${ip}`, 10);
  if (!allowed) {
    return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
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

    // Validate siteHash format (must be SHA-256 hex)
    if (!SITE_HASH_REGEX.test(body.siteHash)) {
      return errorResponse(400, "siteHash must be a valid SHA-256 hex string");
    }

    // Validate version format
    if (!VERSION_REGEX.test(body.version)) {
      return errorResponse(400, "Invalid version format");
    }

    const exists = await pluginExists(env.DB, pluginId);
    if (!exists) {
      return errorResponse(404, "Plugin not found");
    }

    await trackInstall(env.DB, pluginId, body.siteHash, body.version);

    // Phase 17 (DEPR-05) — surface the CLI-facing deprecation warning
    // when the plugin has been deprecated by its author. Active plugins
    // still get an empty-body 202 so existing CLI builds that ignore
    // the response body stay compatible.
    const warning = await getDeprecationWarning(env.DB, pluginId);
    if (warning !== null) {
      return new Response(JSON.stringify({ deprecationWarning: warning }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(null, { status: 202 });
  } catch (err) {
    console.error("[api] Install tracking error:", err);
    return errorResponse(500, "Internal server error");
  }
};
