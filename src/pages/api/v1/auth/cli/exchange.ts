import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  fetchGitHubUser,
  fetchPrimaryEmail,
  upsertAuthor,
  isAuthorBanned,
} from "../../../../../lib/auth/github";
import { createSessionToken } from "../../../../../lib/auth/jwt";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

/**
 * Marketplace JWT exchange for the upstream `emdash` CLI.
 *
 * The CLI completes the GitHub device flow itself (CLI ↔ github.com,
 * polling GitHub's standard endpoints) and then POSTs the resulting
 * GitHub `access_token` here so we can swap it for a marketplace
 * session JWT. The CLI uses that JWT as the `Authorization: Bearer`
 * for all subsequent /api/v1/plugins calls.
 *
 * This is distinct from the RFC 8628 device-flow token endpoint at
 * `/api/v1/auth/device/token`, which is a server-side proxy advertised
 * by `/.well-known/oauth-authorization-server` for agents that want
 * the marketplace to broker the GitHub device exchange end-to-end.
 *
 * Response shape is dictated by the CLI: `{ token, author: { id, name } }`.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { access_token?: unknown };
  try {
    body = (await request.json()) as { access_token?: unknown };
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const accessToken = body.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    return errorResponse(400, "Missing access_token in request body");
  }

  const githubUser = await fetchGitHubUser(accessToken);
  if (!githubUser) {
    return errorResponse(401, "GitHub access token is invalid or expired");
  }

  // Pull the primary verified email so notifications can reach this
  // publisher (noreply addresses filtered inside fetchPrimaryEmail).
  const email = await fetchPrimaryEmail(accessToken);

  const authorId = await upsertAuthor(githubUser, email);

  const ban = await isAuthorBanned(env.DB, authorId);
  if (ban.banned) {
    return errorResponse(
      403,
      ban.reason
        ? `Author is banned from publishing: ${ban.reason}`
        : "Author is banned from publishing",
    );
  }

  const jwt = await createSessionToken(
    authorId,
    githubUser.id,
    githubUser.login,
  );

  return jsonResponse({
    token: jwt,
    author: {
      id: githubUser.id,
      name: githubUser.login,
    },
  });
};
