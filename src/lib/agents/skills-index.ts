const SITE_URL = "https://emdashcms.org";
const MARKETPLACE_SKILL_PATH =
  "/.well-known/agent-skills/marketplace-search/SKILL.md";
const CACHE_KEY = "agents:skills:sha256:marketplace-search";
const CACHE_TTL_SECONDS = 3600;

export interface AgentSkillsIndex {
  $schema: string;
  skills: Array<{
    name: string;
    type: string;
    description: string;
    url: string;
    sha256: string;
  }>;
}

export function buildSkillsIndex(marketplaceSha256: string): AgentSkillsIndex {
  return {
    $schema:
      "https://agentskills.io/schemas/agent-skills-discovery-rfc-v0.2.0.json",
    skills: [
      {
        name: "marketplace-search",
        type: "application/vnd.agent-skill+markdown",
        description:
          "Discover and inspect EmDash CMS plugins and themes via the emdashcms.org MCP server or REST API.",
        url: `${SITE_URL}${MARKETPLACE_SKILL_PATH}`,
        sha256: marketplaceSha256,
      },
    ],
  };
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Resolve the sha256 digest for the marketplace skill asset, using KV as a
 * TTL cache to keep the digest off the hot path. Falls back to recomputing
 * on cache miss or KV outage.
 */
export async function resolveMarketplaceSkillSha256(
  cache: KVNamespace,
  request: Request,
): Promise<string> {
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached) return cached;
  } catch (err) {
    console.error("[agents] KV read failed for skill digest:", err);
  }

  const url = new URL(MARKETPLACE_SKILL_PATH, request.url);
  const res = await fetch(url.toString(), {
    headers: { Accept: "text/markdown" },
  });
  if (!res.ok) {
    throw new Error(
      `Skill asset fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  const text = await res.text();
  const digest = await sha256Hex(text);

  try {
    await cache.put(CACHE_KEY, digest, {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (err) {
    console.error("[agents] KV write failed for skill digest:", err);
  }

  return digest;
}
