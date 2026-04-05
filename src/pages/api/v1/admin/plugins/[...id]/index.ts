import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isSuperAdmin } from "../../../../../../lib/auth/admin";
import { deletePlugin } from "../../../../../../lib/db/admin-queries";
import { errorResponse } from "../../../../../../lib/api/response";

export const prerender = false;

export const DELETE: APIRoute = async ({ params, locals }) => {
  const author = locals.author;
  if (!author || !isSuperAdmin(author.githubId)) {
    return errorResponse(403, "Forbidden");
  }

  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Missing plugin ID");

  const { versionIds } = await deletePlugin(env.DB, pluginId);

  // Clean up R2 artifacts for each version
  for (const versionId of versionIds) {
    try {
      await env.ARTIFACTS.delete(`bundles/${versionId}.tar.gz`);
    } catch {
      // Best-effort cleanup — log but don't fail
    }
  }

  return new Response(JSON.stringify({ ok: true, deleted: pluginId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
