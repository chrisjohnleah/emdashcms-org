import type { APIRoute } from "astro";
import {
  exchangeDeviceCode,
  fetchGitHubUser,
  upsertAuthor,
} from "../../../../../lib/auth/github";
import { createSessionToken } from "../../../../../lib/auth/jwt";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: { device_code?: string };
  try {
    body = (await request.json()) as { device_code?: string };
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const deviceCode = body.device_code;
  if (!deviceCode) {
    return errorResponse(400, "Missing device_code in request body");
  }

  const response = await exchangeDeviceCode(deviceCode);

  // Pending/polling states — let the CLI handle retry logic
  if (response.error) {
    return jsonResponse({ error: response.error });
  }

  // Success — exchange token for session
  if (response.access_token) {
    const githubUser = await fetchGitHubUser(response.access_token);
    if (!githubUser) {
      return errorResponse(502, "Failed to fetch GitHub user profile");
    }

    await upsertAuthor(githubUser);
    const jwt = await createSessionToken(githubUser.id, githubUser.login);

    return jsonResponse({
      token: jwt,
      user: { id: githubUser.id, login: githubUser.login },
    });
  }

  return errorResponse(502, "Unexpected response from GitHub");
};
