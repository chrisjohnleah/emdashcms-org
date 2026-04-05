import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  resolveAuthorId,
  getVersionForRetry,
  incrementRetryCount,
} from "../../../../../../../lib/publishing/plugin-queries";
import { checkPluginAccess, hasRole } from "../../../../../../../lib/auth/permissions";
import { enqueueAuditJob } from "../../../../../../../lib/publishing/queue";
import {
  jsonResponse,
  errorResponse,
} from "../../../../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  const pluginId = params.id;
  const versionStr = params.version;
  if (!pluginId || !versionStr)
    return errorResponse(400, "Plugin ID and version are required");

  try {
    // Resolve GitHub ID to internal author UUID (D-17)
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    // RBAC check — maintainer+ required (D-06)
    const access = await checkPluginAccess(env.DB, authorId, pluginId);
    if (!access.found) return errorResponse(404, "Plugin not found");
    if (!access.role || !hasRole(access.role, "maintainer"))
      return errorResponse(403, "Not authorized");

    // Get version record
    const ver = await getVersionForRetry(env.DB, pluginId, versionStr);
    if (!ver) return errorResponse(404, "Version not found");

    // Only rejected versions can be retried (D-21)
    if (ver.status !== "rejected") {
      return errorResponse(
        400,
        `Cannot retry audit for version with status '${ver.status}'. Only rejected versions can be retried.`,
      );
    }

    // Max 3 retries (D-24)
    if (ver.retryCount >= 3) {
      return errorResponse(
        400,
        "Maximum retry attempts (3) exceeded. Please upload a new version.",
      );
    }

    // Increment retry count and reset status to pending
    await incrementRetryCount(env.DB, ver.id);

    // Re-queue audit job with existing R2 bundle (D-22)
    await enqueueAuditJob(env.AUDIT_QUEUE, {
      pluginId,
      version: versionStr,
      authorId,
      bundleKey: ver.bundleKey,
    });

    return jsonResponse(
      {
        version: versionStr,
        status: "pending",
        retryCount: ver.retryCount + 1,
        message: "Audit retry queued",
      },
      202,
    );
  } catch (err) {
    console.error("[api] Retry audit error:", err);
    return errorResponse(500, "Internal server error");
  }
};
