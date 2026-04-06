import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  exchangeCodeForToken,
  fetchGitHubUser,
  upsertAuthor,
  isAuthorBanned,
} from "../../../../lib/auth/github";
import { createSessionToken } from "../../../../lib/auth/jwt";
import { setSessionCookie, clearSessionCookie } from "../../../../lib/auth/session";
import { errorResponse } from "../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const url = new URL(request.url);

  // CSRF state validation
  const state = url.searchParams.get("state");
  const storedState = cookies.get("oauth_state")?.value;
  cookies.delete("oauth_state", { path: "/" });

  if (!state || state !== storedState) {
    return errorResponse(403, "Invalid OAuth state");
  }

  // GitHub error (user denied, etc.)
  const error = url.searchParams.get("error");
  if (error) {
    return errorResponse(400, `GitHub OAuth error: ${error}`);
  }

  // Exchange code for token
  const code = url.searchParams.get("code");
  if (!code) {
    return errorResponse(400, "Missing authorization code");
  }

  const accessToken = await exchangeCodeForToken(code);
  if (!accessToken) {
    return errorResponse(502, "Failed to exchange code with GitHub");
  }

  const githubUser = await fetchGitHubUser(accessToken);
  if (!githubUser) {
    return errorResponse(502, "Failed to fetch GitHub user profile");
  }

  // Create/update author record
  const authorId = await upsertAuthor(githubUser);

  // Ban check — do this BEFORE issuing a session. Banned authors get
  // redirected to the homepage with a banner and no cookie.
  const ban = await isAuthorBanned(env.DB, authorId);
  if (ban.banned) {
    clearSessionCookie(cookies);
    return redirect("/?banned=1", 302);
  }

  const jwt = await createSessionToken(authorId, githubUser.id, githubUser.login);
  setSessionCookie(cookies, jwt);

  return redirect("/dashboard", 302);
};
