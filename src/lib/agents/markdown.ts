import { searchPlugins, searchThemes } from "../db/queries";
import type {
  MarketplacePluginSummary,
  MarketplaceThemeSummary,
} from "../../types/marketplace";
import { markdownResponse } from "./response";

const SITE_URL = "https://emdashcms.org";

const MARKDOWN_PATHS = new Set<string>(["/", "/plugins"]);

/**
 * Returns true if the caller prefers text/markdown over text/html.
 * Handles both explicit quality values and the common `Accept: text/markdown`
 * agent header.
 */
function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const entries = accept.split(",").map((raw) => {
    const [type, ...params] = raw.trim().split(";").map((s) => s.trim());
    const qParam = params.find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
  });

  let markdownQ = 0;
  let htmlQ = 0;
  for (const entry of entries) {
    if (entry.type === "text/markdown") markdownQ = Math.max(markdownQ, entry.q);
    else if (entry.type === "text/html") htmlQ = Math.max(htmlQ, entry.q);
  }

  return markdownQ > 0 && markdownQ >= htmlQ;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\s]+/g, " ").trim();
}

function pluginLine(p: MarketplacePluginSummary): string {
  const desc = p.shortDescription ?? p.description ?? p.name;
  return `- [${p.name}](${SITE_URL}/plugins/${p.id}) — ${oneLine(desc)}`;
}

function themeLine(t: MarketplaceThemeSummary): string {
  const desc = t.shortDescription ?? t.description ?? t.name;
  return `- [${t.name}](${SITE_URL}/themes/${t.id}) — ${oneLine(desc)}`;
}

export async function buildHomepageMarkdown(db: D1Database): Promise<string> {
  const [latest, popular, themesRes] = await Promise.all([
    searchPlugins(db, {
      query: "",
      category: null,
      capability: null,
      sort: "created",
      cursor: null,
      limit: 6,
    }),
    searchPlugins(db, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 6,
    }),
    searchThemes(db, {
      query: "",
      category: null,
      keyword: null,
      sort: "created",
      cursor: null,
      limit: 4,
    }),
  ]);

  const parts: string[] = [];
  parts.push("# emdashcms.org");
  parts.push("");
  parts.push(
    "> A community marketplace for EmDash CMS plugins and themes. Free to install, free to publish, MIT licensed. Every release passes a fail-closed security audit before shipping.",
  );
  parts.push("");

  if (latest.items.length) {
    parts.push("## Latest plugins");
    parts.push("");
    for (const p of latest.items) parts.push(pluginLine(p));
    parts.push("");
  }

  const featuredIds = new Set(latest.items.map((p) => p.id));
  const popularFiltered = popular.items.filter((p) => !featuredIds.has(p.id));
  if (popularFiltered.length) {
    parts.push("## Most installed");
    parts.push("");
    for (const p of popularFiltered) parts.push(pluginLine(p));
    parts.push("");
  }

  if (themesRes.items.length) {
    parts.push("## Latest themes");
    parts.push("");
    for (const t of themesRes.items) parts.push(themeLine(t));
    parts.push("");
  }

  parts.push("## For agents");
  parts.push("");
  parts.push(
    `- MCP server: \`${SITE_URL}/mcp\` (card: \`${SITE_URL}/.well-known/mcp/server-card.json\`)`,
  );
  parts.push(`- REST API: \`${SITE_URL}/api/v1\``);
  parts.push(
    `- OpenAPI: \`${SITE_URL}/api/v1/openapi.json\` · Catalog: \`${SITE_URL}/.well-known/api-catalog\``,
  );
  parts.push("");

  return parts.join("\n");
}

export async function buildPluginsIndexMarkdown(
  db: D1Database,
  searchParams: URLSearchParams,
): Promise<string> {
  const query = searchParams.get("query") ?? "";
  const category = searchParams.get("category");
  const capability = searchParams.get("capability");
  const sort = searchParams.get("sort") ?? "installs";

  const result = await searchPlugins(db, {
    query,
    category,
    capability,
    sort,
    cursor: null,
    limit: 50,
  });

  const parts: string[] = [];
  parts.push("# Plugins — emdashcms.org");
  parts.push("");
  const filters: string[] = [];
  if (query) filters.push(`query="${query}"`);
  if (category) filters.push(`category=${category}`);
  if (capability) filters.push(`capability=${capability}`);
  if (sort !== "installs") filters.push(`sort=${sort}`);
  const filterSummary = filters.length ? ` (${filters.join(", ")})` : "";
  parts.push(`> ${result.items.length} result(s)${filterSummary}.`);
  parts.push("");

  if (!result.items.length) {
    parts.push(
      "No plugins match these filters. Try removing filters, or browse all at https://emdashcms.org/plugins.",
    );
    parts.push("");
  } else {
    for (const p of result.items) parts.push(pluginLine(p));
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Negotiate text/markdown on the two paths where a markdown summary is
 * genuinely useful for agents. Returns null to let normal HTML rendering
 * proceed for everything else (including when the caller prefers HTML).
 */
export async function handleMarkdownNegotiation(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  if (!MARKDOWN_PATHS.has(url.pathname)) return null;

  if (!prefersMarkdown(request.headers.get("Accept"))) return null;

  try {
    const body =
      url.pathname === "/"
        ? await buildHomepageMarkdown(env.DB)
        : await buildPluginsIndexMarkdown(env.DB, url.searchParams);
    return markdownResponse(body);
  } catch (err) {
    console.error("[agents] markdown build failed:", err);
    return null;
  }
}
