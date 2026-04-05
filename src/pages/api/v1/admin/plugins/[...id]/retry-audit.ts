import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import {
  getVersionForRetry,
  incrementRetryCount,
} from "../../../../../../lib/publishing/plugin-queries";
import { enqueueAuditJob } from "../../../../../../lib/publishing/queue";
import {
  jsonResponse,
  errorResponse,
} from "../../../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  let version: string;
  try {
    const body = await request.json();
    version = (body as { version: string }).version;
  } catch {
    return errorResponse(400, "Request body must include { version }");
  }

  if (!version) return errorResponse(400, "Missing version");

  try {
    const ver = await getVersionForRetry(env.DB, pluginId, version);
    if (!ver) return errorResponse(404, "Version not found");

    if (ver.status !== "rejected") {
      return errorResponse(
        400,
        `Cannot retry audit for version with status '${ver.status}'.`,
      );
    }

    await incrementRetryCount(env.DB, ver.id);

    await enqueueAuditJob(env.AUDIT_QUEUE, {
      pluginId,
      version,
      authorId: author.id,
      bundleKey: ver.bundleKey,
    });

    return jsonResponse(
      {
        version,
        status: "pending",
        retryCount: ver.retryCount + 1,
        message: "Audit retry queued by admin",
      },
      202,
    );
  } catch (err) {
    console.error("[admin] Retry audit error:", err);
    return errorResponse(500, "Internal server error");
  }
};
