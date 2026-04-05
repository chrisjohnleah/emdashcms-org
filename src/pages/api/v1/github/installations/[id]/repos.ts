import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getInstallation } from "../../../../../../lib/github/queries";
import { getInstallationToken, listInstallationRepos } from "../../../../../../lib/github/installation";
import { resolveAuthorId } from "../../../../../../lib/publishing/plugin-queries";
import { jsonResponse, errorResponse } from "../../../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const installationId = Number(params.id);
  if (!installationId || isNaN(installationId)) {
    return errorResponse(400, "Invalid installation ID");
  }

  const author = locals.author;
  if (!author) return errorResponse(401, "Authentication required");

  const authorId = await resolveAuthorId(env.DB, author.githubId);
  if (!authorId) return errorResponse(401, "Author not found");

  // Verify the installation belongs to this author
  const installation = await getInstallation(env.DB, installationId);
  if (!installation || installation.authorId !== authorId) {
    return errorResponse(403, "Installation not accessible");
  }

  try {
    const token = await getInstallationToken(
      installationId,
      env.GITHUB_CLIENT_ID,
      env.GITHUB_APP_PRIVATE_KEY,
    );
    const repos = await listInstallationRepos(token);
    return jsonResponse(repos);
  } catch (err) {
    console.error("[github] List repos error:", err);
    return errorResponse(500, "Failed to list repositories");
  }
};
