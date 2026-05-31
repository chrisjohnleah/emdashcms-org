import type {
  MarketplacePluginSummary,
  MarketplaceThemeSummary,
} from "../../types/marketplace";

/**
 * Pure builder for /llms.txt — the machine-readable marketplace index
 * crawled by AI search engines (Claude, Perplexity, ChatGPT, Google AI
 * Overviews). Spec: https://llmstxt.org/
 *
 * The file is markdown, but its structure is rigid: an H1 with the
 * site name, a `>` blockquote summary, then zero or more H2 sections
 * of bullet links. AI crawlers hydrate that shape into site metadata,
 * so deviations (empty H2s, multi-line bullets) break parsing.
 *
 * The builder is pure so we can unit-test empty-state handling,
 * description fallbacks, and the hard cap without touching D1.
 */

const SITE_URL = "https://emdashcms.org";

const SUMMARY =
  "The community marketplace for EmDash CMS plugins and themes. Free to install, free to publish, MIT licensed. Every release passes a fail-closed security audit before shipping.";

const SECTION_CAP = 25;

export interface LlmsTxtInput {
  featured: MarketplacePluginSummary[];
  recentlyUpdated: MarketplacePluginSummary[];
  themes: MarketplaceThemeSummary[];
}

// Collapse any whitespace runs (including \n/\r) to single spaces so
// each bullet stays one line. The llms.txt spec is markdown; a newline
// inside a bullet line silently breaks list parsing.
function oneLine(text: string): string {
  return text.replace(/[\r\n\s]+/g, " ").trim();
}

function pluginBullet(p: MarketplacePluginSummary): string {
  const desc = p.shortDescription ?? p.description ?? p.name;
  return `- [${p.name}](${SITE_URL}/plugins/${p.id}): ${oneLine(desc)}`;
}

function themeBullet(t: MarketplaceThemeSummary): string {
  const desc = t.shortDescription ?? t.description ?? t.name;
  return `- [${t.name}](${SITE_URL}/themes/${t.id}): ${oneLine(desc)}`;
}

export function buildLlmsTxt(input: LlmsTxtInput): string {
  const parts: string[] = [];

  parts.push("# EmDash CMS Marketplace");
  parts.push("");
  parts.push(`> ${SUMMARY}`);

  if (input.featured.length > 0) {
    parts.push("");
    parts.push("## Featured Plugins");
    parts.push("");
    for (const plugin of input.featured.slice(0, SECTION_CAP)) {
      parts.push(pluginBullet(plugin));
    }
  }

  if (input.recentlyUpdated.length > 0) {
    parts.push("");
    parts.push("## Recently Updated Plugins");
    parts.push("");
    for (const plugin of input.recentlyUpdated.slice(0, SECTION_CAP)) {
      parts.push(pluginBullet(plugin));
    }
  }

  if (input.themes.length > 0) {
    parts.push("");
    parts.push("## Themes");
    parts.push("");
    for (const theme of input.themes.slice(0, SECTION_CAP)) {
      parts.push(themeBullet(theme));
    }
  }

  parts.push("");
  parts.push("## Start Here");
  parts.push("");
  parts.push(
    "- [Start with EmDash](https://emdashcms.org/start): get the CMS, connect the marketplace, install extensions, publish work, and join the community",
  );
  parts.push(
    "- [About emdashcms.org](https://emdashcms.org/about): what this ecosystem site is, how it differs from the core CMS, and where support, policy, and security reports live",
  );
  parts.push(
    "- [Roadmap](https://emdashcms.org/roadmap): what exists now, what improves next, and what the project will not claim before it is real",
  );
  parts.push(
    "- [Learn](https://emdashcms.org/learn): plain-English guides to EmDash CMS, plugins, manifests, and capabilities",
  );
  parts.push(
    "- [Developer resources](https://emdashcms.org/developers): OpenAPI, MCP, feeds, badges, and extension references",
  );
  parts.push(
    "- [Install guide](https://emdashcms.org/guide): how site owners install marketplace plugins",
  );
  parts.push(
    "- [Support](https://emdashcms.org/support): install help, plugin-specific support routes, publisher help, status, reports, and project issues",
  );
  parts.push(
    "- [Community](https://emdashcms.org/community): ways to publish, test, document, review, moderate, and build",
  );
  parts.push(
    "- [Authors & Publishers](https://emdashcms.org/authors): discover plugins and themes by the people shipping them",
  );
  parts.push(
    "- [For Agencies](https://emdashcms.org/for/agencies): EmDash positioning for client work and safe plugin ecosystems",
  );
  parts.push("");
  parts.push("## API");
  parts.push("");
  parts.push(
    "- [Marketplace API](https://emdashcms.org/api/v1/plugins): public read endpoint matching the MarketplaceClient contract",
  );
  parts.push(
    "- [Contributor guide](https://emdashcms.org/docs/contributors): how to publish a plugin",
  );
  parts.push("");

  return parts.join("\n");
}
