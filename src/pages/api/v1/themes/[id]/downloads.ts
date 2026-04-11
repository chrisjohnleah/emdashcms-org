import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  incrementThemeDownloads,
  themeExists,
  hashIpForTarget,
} from "../../../../../lib/downloads/queries";
import { errorResponse } from "../../../../../lib/api/response";
import { checkRateLimit } from "../../../../../lib/downloads/rate-limit";

export const prerender = false;

/**
 * Theme outbound-click tracking. Themes are metadata-only — there is no
 * bundle in our R2 — so the only signal we can capture for "interest"
 * is the moment a user clicks through to npm/repo/demo from the theme
 * detail page. The page sends a `navigator.sendBeacon()` POST here just
 * before the link navigates, then increments `themes.downloads_count`.
 *
 * Returns 202 with no body so the response is the smallest possible
 * payload — sendBeacon doesn't read it but the browser still buffers it.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const { id: themeId } = params;

  if (!themeId) {
    return errorResponse(400, "Theme ID is required");
  }

  // Two layers of abuse protection (mirrors the bundle endpoint):
  //
  //   1. Per-IP rate limit (30/min on the `theme-download:` bucket so
  //      it can't deplete the shared install budget) blocks flood
  //      spam at the edge.
  //   2. Lifetime per-(IP, theme_id) dedup inside
  //      `incrementThemeDownloads`: the same IP clicking through to
  //      this theme a second time is recorded but does NOT bump the
  //      counter. The counter measures *unique IPs* who showed install
  //      intent for this theme, not raw beacon hits.
  //
  // The IP is hashed with `theme:{themeId}` as salt so the dedup table
  // can't be used to correlate "this IP looked at themes A, B, C" if
  // D1 ever leaks. Raw IPs are never written.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed } = await checkRateLimit(
    env.DB,
    `theme-download:${ip}`,
    30,
  );
  if (!allowed) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  try {
    const exists = await themeExists(env.DB, themeId);
    if (!exists) {
      return errorResponse(404, "Theme not found");
    }

    const ipHash = await hashIpForTarget(ip, `theme:${themeId}`);
    await incrementThemeDownloads(env.DB, themeId, ipHash);

    return new Response(null, { status: 202 });
  } catch (err) {
    console.error("[api] Theme download tracking error:", err);
    return errorResponse(500, "Internal server error");
  }
};
