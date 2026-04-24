import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse } from "../../../../../../lib/api/response";
import {
  checkPluginAccess,
  hasRole,
} from "../../../../../../lib/auth/permissions";
import { resolveAuthorId } from "../../../../../../lib/publishing/plugin-queries";
import { searchSuccessorCandidates } from "../../../../../../lib/publishing/deprecation-queries";

export const prerender = false;

/**
 * Typeahead backing the deprecate form's successor picker.
 *
 * Auth: requires a session cookie (middleware populates `locals.author`
 * for dashboard routes). Unauthenticated callers get a 401.
 *
 * Authorization: the caller must be an owner or maintainer on the target
 * plugin. Contributors and strangers get a 403 to match the metadata
 * PATCH convention established in Phase 11-03.
 *
 * Scope is already enforced by the underlying library — non-deprecated,
 * non-unlisted, non-self, has a published version — and re-validated
 * server-side on every write in 17-01, so a stale client cannot slip a
 * poisoned successor id past deprecatePlugin (T-17-10).
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const pluginId = params.id;
  if (!pluginId) {
    return errorResponse(400, "Plugin ID is required");
  }

  const author = locals.author;
  if (!author) {
    return errorResponse(401, "Authentication required");
  }

  const authorId = await resolveAuthorId(env.DB, author.githubId);
  if (!authorId) return errorResponse(401, "Author not found");

  const access = await checkPluginAccess(env.DB, authorId, pluginId);
  if (!access.found) return errorResponse(404, "Plugin not found");
  if (!access.role || !hasRole(access.role, "maintainer")) {
    return errorResponse(403, "Not authorised to list successor candidates");
  }

  const url = new URL(request.url);
  const rawQ = url.searchParams.get("q") ?? "";
  if (rawQ.length > 80) {
    return errorResponse(400, "q must be 80 characters or fewer");
  }
  const q = rawQ.trim();

  const candidates = await searchSuccessorCandidates(env.DB, q, pluginId, 10);

  return new Response(JSON.stringify({ candidates }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
