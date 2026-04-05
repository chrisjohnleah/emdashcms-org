import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getPublishedVersionBundle } from "../../../../../../../lib/downloads/queries";
import { errorResponse } from "../../../../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
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
