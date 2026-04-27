import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";

export const prerender = false;

/**
 * Discovery document consumed by the upstream `emdash` CLI when invoked
 * with `--registry https://emdashcms.org`. The CLI reads this first, then
 * uses the embedded GitHub clientId for the device flow and the marketplace
 * deviceTokenEndpoint to swap a GitHub access token for a session JWT.
 *
 * Fail-closed when GITHUB_CLIENT_ID is missing rather than emitting a
 * payload that would 404 the CLI downstream — that's the exact failure
 * mode upstream's marketplace.emdashcms.com is hitting today (their
 * discovery omits clientId, so the CLI sends client_id: undefined and
 * GitHub returns 404).
 */
export const GET: APIRoute = () => {
  if (!env.GITHUB_CLIENT_ID) {
    return errorResponse(500, "Marketplace is missing GITHUB_CLIENT_ID");
  }

  return jsonResponse({
    github: {
      deviceAuthorizationEndpoint: "https://github.com/login/device/code",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId: env.GITHUB_CLIENT_ID,
    },
    marketplace: {
      deviceTokenEndpoint: "/api/v1/auth/device/token",
    },
  });
};
