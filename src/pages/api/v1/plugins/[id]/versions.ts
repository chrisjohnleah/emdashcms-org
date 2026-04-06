import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getPluginVersions } from "../../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";
import {
  resolveAuthorId,
  checkUploadRateLimit,
  checkVersionExists,
  createVersion,
} from "../../../../../lib/publishing/plugin-queries";
import { checkPluginAccess, hasRole } from "../../../../../lib/auth/permissions";
import { validateBundle } from "../../../../../lib/publishing/bundle-validator";
import { storeBundleInR2 } from "../../../../../lib/publishing/r2-storage";
import { enqueueAuditJob } from "../../../../../lib/publishing/queue";
import {
  checkAuthorAuditBudget,
  recordAuthorAuditUsage,
} from "../../../../../lib/audit/author-budget";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;

  if (!id) {
    return errorResponse(400, "Plugin ID is required");
  }

  try {
    const versions = await getPluginVersions(env.DB, id);
    return jsonResponse(versions);
  } catch (err) {
    console.error("[api] Plugin versions error:", err);
    return errorResponse(500, "Internal server error");
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Plugin ID is required");

  try {
    // Step 1: Auth already handled by middleware
    // Step 2: Resolve GitHub ID to internal author UUID (D-17)
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    // Step 3: RBAC check — maintainer+ required (D-06)
    const access = await checkPluginAccess(env.DB, authorId, pluginId);
    if (!access.found) return errorResponse(404, "Plugin not found");
    if (!access.role || !hasRole(access.role, "maintainer"))
      return errorResponse(
        403,
        "Not authorized to upload versions for this plugin",
      );

    // Step 5: Rate limit check (D-18, COST-01)
    const rateLimit = await checkUploadRateLimit(env.DB, authorId);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded: 5 versions per day",
          retryAfter: rateLimit.retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": rateLimit.retryAfter!,
          },
        },
      );
    }

    // Step 6: Parse multipart form
    const formData = await request.formData();
    const file = formData.get("tarball");
    if (!(file instanceof File))
      return errorResponse(
        400,
        "Missing tarball file in form field 'tarball'",
      );

    // Steps 7-11: Validate bundle (compressed size, extract, manifest, constraints, supply chain)
    const tarballBytes = await file.arrayBuffer();
    const validation = await validateBundle(tarballBytes, pluginId);
    if (!validation.valid) {
      return errorResponse(
        400,
        `Bundle validation failed: ${validation.errors!.join("; ")}`,
      );
    }

    // Check version not already uploaded (409 instead of UNIQUE constraint error)
    const versionStr = validation.manifest!.version;
    const exists = await checkVersionExists(env.DB, pluginId, versionStr);
    if (exists)
      return errorResponse(
        409,
        `Version ${versionStr} already exists for this plugin`,
      );

    // Audit budget check (COST-03) — runs BEFORE we write to R2 or D1.
    // If the budget is exhausted, we'd otherwise leave an orphaned R2
    // object and a "pending" version row that never gets audited.
    const budget = await checkAuthorAuditBudget(env.DB, authorId);
    if (!budget.allowed) {
      return errorResponse(429, "Daily audit limit reached (10/day). Try again tomorrow.");
    }

    // Steps 12-13: Store in R2 (checksum already computed by validateBundle)
    const { key: bundleKey } = await storeBundleInR2(
      env.ARTIFACTS,
      pluginId,
      versionStr,
      tarballBytes,
      validation.checksum!,
    );

    // Step 14: Create D1 version record
    const versionId = await createVersion(env.DB, {
      pluginId,
      version: versionStr,
      manifest: JSON.stringify(validation.manifest),
      bundleKey,
      checksum: validation.checksum!,
      fileCount: validation.stats!.fileCount,
      compressedSize: validation.stats!.compressedSize,
      decompressedSize: validation.stats!.decompressedSize,
      changelog: validation.manifest!.changelog ?? undefined,
      minEmDashVersion: validation.manifest!.minEmDashVersion ?? undefined,
    });

    await enqueueAuditJob(env.AUDIT_QUEUE, {
      pluginId,
      version: versionStr,
      authorId,
      bundleKey,
    });
    await recordAuthorAuditUsage(env.DB, authorId);

    // Step 16: Return 202 Accepted
    return jsonResponse(
      {
        id: versionId,
        version: versionStr,
        status: "pending",
        message: "Version uploaded, audit queued",
      },
      202,
    );
  } catch (err) {
    console.error("[api] Version upload error:", err);
    return errorResponse(500, "Internal server error");
  }
};
