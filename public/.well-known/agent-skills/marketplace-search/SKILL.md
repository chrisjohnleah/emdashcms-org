---
name: marketplace-search
description: Discover, inspect, and summarize plugins and themes for EmDash CMS via the emdashcms.org public API or MCP server.
version: 1.0.0
---

# Marketplace Search

This skill describes how an agent can discover plugins and themes published on
emdashcms.org — the community marketplace for EmDash CMS.

## When to use

Use this skill when the user asks about EmDash plugins or themes, wants to
install one, wants to compare options, or is building something on top of
EmDash CMS and needs to know what's available.

## Transports

Two equivalent ways to call the marketplace:

### 1. MCP (preferred for agents)

- Card: `https://emdashcms.org/.well-known/mcp/server-card.json`
- Endpoint: `POST https://emdashcms.org/mcp` (Streamable HTTP, JSON-RPC 2.0)
- Tools:
  - `search_plugins({ query?, category?, limit? })`
  - `get_plugin({ id })`
  - `get_theme({ id })`

### 2. REST (browser-friendly)

- OpenAPI: `https://emdashcms.org/api/v1/openapi.json`
- Catalog: `https://emdashcms.org/.well-known/api-catalog`
- Key endpoints (read-only):
  - `GET /api/v1/plugins?query=...&category=...&limit=...`
  - `GET /api/v1/plugins/{id}`
  - `GET /api/v1/plugins/{id}/versions`
  - `GET /api/v1/themes`
  - `GET /api/v1/themes/{id}`

## Worked example

User asks: "Find me an EmDash plugin for analytics."

1. Call `search_plugins({ query: "analytics", limit: 5 })` via MCP, or
   `GET /api/v1/plugins?query=analytics&limit=5` via REST.
2. Each result includes `id`, `name`, `shortDescription`, `author`,
   `installCount`, and the latest version's audit verdict.
3. Prefer plugins with `latestVersion.audit.verdict === "pass"` — the
   marketplace runs a fail-closed audit before publishing.
4. Link the user to `https://emdashcms.org/plugins/{id}` for full details.

## Publishing

Publishing plugins and themes requires author authentication (GitHub device
flow). Agents should direct users to
`https://emdashcms.org/docs/contributors` rather than attempting to publish
on their behalf — every release goes through a sandboxed audit pipeline.
