import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  getPublishedVersionBundle,
  incrementPluginDownloads,
} from "../../../../../../../lib/downloads/queries";
import { errorResponse } from "../../../../../../../lib/api/response";
import { checkRateLimit } from "../../../../../../../lib/downloads/rate-limit";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const { id: pluginId, version } = params;

  if (!pluginId || !version) {
    return errorResponse(400, "Plugin ID and version are required");
  }

  try {
    const versionInfo = await getPublishedVersionBundle(
      env.DB,
      pluginId,
      version,
    );
    if (!versionInfo) {
      return errorResponse(404, "Version not found or not yet published");
    }

    const r2Object = await env.ARTIFACTS.get(versionInfo.bundleKey);
    if (!r2Object) {
      return errorResponse(404, "Bundle not found in storage");
    }

    // Track raw download (browser ZIP click + CLI both flow through here).
    // Per-IP rate limit: 60/min — generous enough for paginated CLI
    // installs across a monorepo, tight enough to deflect reload-spam.
    // Counter is only bumped when the limiter allows the request, so a
    // single curl loop can't drive the number arbitrarily high.
    // Fire-and-forget via waitUntil so the bundle stream starts
    // immediately; failures are logged but never block the download.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const trackPromise = (async () => {
      try {
        const { allowed } = await checkRateLimit(
          env.DB,
          `download:${ip}`,
          60,
        );
        if (allowed) {
          await incrementPluginDownloads(env.DB, pluginId);
        }
      } catch (err) {
        console.error("[api] Download tracking failed:", err);
      }
    })();
    locals.cfContext?.waitUntil?.(trackPromise);

    return new Response(r2Object.body, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${`${pluginId}-${version}.tgz`.replace(/[^a-zA-Z0-9@._-]/g, "_")}"`,
        "Content-Length": String(r2Object.size),
        ETag: r2Object.httpEtag,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (err) {
    console.error("[api] Bundle download error:", err);
    return errorResponse(500, "Internal server error");
  }
};
