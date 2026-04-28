import { MARKETPLACE_SEARCH_SHA256 } from "./skill-digests.generated";

const SITE_URL = "https://emdashcms.org";
const MARKETPLACE_SKILL_PATH =
  "/.well-known/agent-skills/marketplace-search/SKILL.md";

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

export function buildSkillsIndex(
  marketplaceSha256: string = MARKETPLACE_SEARCH_SHA256,
): AgentSkillsIndex {
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
