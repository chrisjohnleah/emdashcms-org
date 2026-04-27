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
      // The CLI completes the GitHub device flow itself, then POSTs the
      // resulting GitHub access_token here for a marketplace JWT. This
      // is NOT the RFC 8628 token endpoint (that lives at
      // /api/v1/auth/device/token and is advertised separately for
      // agents that want a server-side device-flow proxy).
      deviceTokenEndpoint: "/api/v1/auth/cli/exchange",
    },
  });
};
