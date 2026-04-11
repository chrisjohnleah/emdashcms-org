import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  getPublishedVersionBundle,
  incrementPluginDownloads,
  hashIpForTarget,
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

    // Track raw download — every fetch flows through this endpoint:
    // browser ZIP clicks AND the EmDash CMS install endpoint pulling
    // the bundle into a site's local R2 (the marketplace is a
    // distribution channel, not a runtime dependency, per upstream's
    // packages/core/src/plugins/marketplace.ts).
    //
    // Two layers of abuse protection:
    //   1. Per-IP rate limit (60/min) blocks flood spam at the edge so a
    //      single attacker can't even reach the dedup table 1000 times
    //      a minute.
    //   2. Lifetime per-(IP, plugin, version) dedup inside
    //      `incrementPluginDownloads`: the same IP downloading the same
    //      version a second time is recorded but does NOT bump the
    //      counters. The counter measures *unique IPs* who fetched
    //      this version, not raw HTTP requests.
    //
    // The IP is hashed with the plugin_id as salt so the dedup table
    // can never be used to correlate "this IP downloaded plugins
    // A, B, C" if D1 ever leaks. Raw IPs are never written to D1.
    //
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
        if (!allowed) return;
        const ipHash = await hashIpForTarget(ip, pluginId);
        await incrementPluginDownloads(env.DB, pluginId, version, ipHash);
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
