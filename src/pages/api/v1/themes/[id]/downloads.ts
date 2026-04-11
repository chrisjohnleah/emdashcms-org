import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  incrementThemeDownloads,
  themeExists,
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

  // Per-IP rate limit: 30 clicks/min. Same shared rate_limits table the
  // installs route uses; the `theme-download:` prefix keeps the bucket
  // distinct so download-tracking can't deplete the install budget.
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

    await incrementThemeDownloads(env.DB, themeId);

    return new Response(null, { status: 202 });
  } catch (err) {
    console.error("[api] Theme download tracking error:", err);
    return errorResponse(500, "Internal server error");
  }
};
