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
import { AUDIT_MODELS } from "../../../../../../lib/audit/prompt";
import type { AuditModelKey } from "../../../../../../types/marketplace";

export const prerender = false;

/**
 * Admin override: re-run an audit on a specific version with an
 * explicit mode, regardless of the Worker's global AUDIT_MODE.
 *
 * Body: { version: string, mode: 'static' | 'ai', model?: AuditModelKey }
 *
 * - 'static': run the static scanner only, no AI call. Records findings,
 *   leaves the version 'pending'. Free to run as many times as you like.
 * - 'ai': run static + AI. Subject to the daily neuron budget; falls
 *   back to static-only if budget is exhausted. The optional `model`
 *   field selects which AI model runs (see AUDIT_MODELS); ignored when
 *   mode is 'static'. Defaults to the registry default when omitted.
 *
 * The mode label is intentionally user-friendly. It maps internally to
 * the consumer's auditModeOverride: 'static' → 'manual', 'ai' → 'auto'.
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  let version: string;
  let mode: "static" | "ai";
  let modelOverride: AuditModelKey | undefined;
  try {
    const body = (await request.json()) as {
      version: string;
      mode: string;
      model?: string;
    };
    version = body.version;
    if (body.mode !== "static" && body.mode !== "ai") {
      return errorResponse(400, "mode must be 'static' or 'ai'");
    }
    mode = body.mode;

    if (body.model !== undefined) {
      if (!(body.model in AUDIT_MODELS)) {
        return errorResponse(
          400,
          `model must be one of: ${Object.keys(AUDIT_MODELS).join(", ")}`,
        );
      }
      modelOverride = body.model as AuditModelKey;
    }
  } catch {
    return errorResponse(
      400,
      "Request body must be { version, mode: 'static' | 'ai', model? }",
    );
  }

  if (!version) return errorResponse(400, "Missing version");

  try {
    const ver = await getVersionForRetry(env.DB, pluginId, version);
    if (!ver) return errorResponse(404, "Version not found");

    // Always increment retry count so we can see attempts in the UI
    await incrementRetryCount(env.DB, ver.id);

    const auditModeOverride = mode === "ai" ? "auto" : "manual";

    console.log(
      `[run-audit] Enqueueing audit: plugin=${pluginId} version=${version} mode=${mode} auditModeOverride=${auditModeOverride} model=${modelOverride ?? "default"} bundleKey=${ver.bundleKey}`,
    );

    await enqueueAuditJob(env.AUDIT_QUEUE, {
      pluginId,
      version,
      authorId: author.id,
      bundleKey: ver.bundleKey,
      auditModeOverride,
      // model only applies on the AI path; sending it for static is harmless
      // (consumer ignores it when not in auto mode) but we strip it anyway.
      modelOverride: mode === "ai" ? modelOverride : undefined,
    });

    console.log(
      `[run-audit] Enqueued successfully: plugin=${pluginId} version=${version}`,
    );

    return jsonResponse(
      {
        version,
        mode,
        model: mode === "ai" ? (modelOverride ?? null) : null,
        status: "pending",
        retryCount: ver.retryCount + 1,
        message:
          mode === "ai"
            ? `Audit re-queued by admin in AI mode (model: ${modelOverride ?? "default"})`
            : "Audit re-queued by admin in static mode",
      },
      202,
    );
  } catch (err) {
    console.error("[admin] run-audit error:", err);
    return errorResponse(500, "Internal server error");
  }
};
