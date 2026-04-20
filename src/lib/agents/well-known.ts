import { buildApiCatalog } from "./api-catalog";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "./oauth-metadata";
import { buildMcpServerCard } from "./mcp-server-card";
import { buildSkillsIndex, resolveMarketplaceSkillSha256 } from "./skills-index";
import {
  linksetJson,
  oauthJson,
  mcpCardJson,
  skillsJson,
} from "./response";

/**
 * Worker-level router for /.well-known/* paths that need dynamic responses.
 * Returns a Response for handled paths, or null so the caller can delegate
 * to Astro's handler for everything else (including unmatched well-known
 * paths served as static assets from public/.well-known/).
 */
export async function handleWellKnown(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const path = url.pathname;

  switch (path) {
    case "/.well-known/api-catalog":
      return linksetJson(buildApiCatalog());

    case "/.well-known/oauth-authorization-server":
      return oauthJson(buildAuthorizationServerMetadata());

    case "/.well-known/oauth-protected-resource":
      return oauthJson(buildProtectedResourceMetadata());

    case "/.well-known/mcp/server-card.json":
      return mcpCardJson(buildMcpServerCard());

    case "/.well-known/agent-skills/index.json": {
      try {
        const sha = await resolveMarketplaceSkillSha256(env.CACHE, request);
        return skillsJson(buildSkillsIndex(sha));
      } catch (err) {
        console.error("[agents] skills index build failed:", err);
        return new Response(
          JSON.stringify({ error: "Skills index temporarily unavailable" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    default:
      return null;
  }
}
