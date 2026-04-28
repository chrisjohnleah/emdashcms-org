---
name: marketplace-search
description: Discover, inspect, and summarize plugins and themes for EmDash CMS via the emdashcms.org public API or MCP server.
version: 1.1.0
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
  - `search_plugins({ query?, category?, capability?, sort?, limit? })` —
    `sort` is one of `installs` (default) | `updated` | `created`. `limit`
    is clamped to 1–50 (default 10). Returns `{ items, nextCursor }`.
  - `get_plugin({ id })` — full plugin detail, including the latest
    version's audit findings, readme, and screenshots.
  - `get_theme({ id })` — full theme detail by slug. Theme search is
    REST-only today; use `GET /api/v1/themes` for discovery and call
    `get_theme` once you have an id.

### 2. REST (browser-friendly)

- OpenAPI: `https://emdashcms.org/api/v1/openapi.json`
- Catalog: `https://emdashcms.org/.well-known/api-catalog`
- Read-only endpoints:
  - `GET /api/v1/plugins?query=&category=&capability=&sort=&cursor=&limit=`
  - `GET /api/v1/plugins/{id}`
  - `GET /api/v1/plugins/{id}/versions`
  - `GET /api/v1/themes?query=&category=&keyword=&sort=&cursor=&limit=`
  - `GET /api/v1/themes/{id}`

Pagination is cursor-based: pass back the `nextCursor` from the previous
response to page forward.

## Result shape

Plugin and theme summaries include:

- `id`, `name`, `shortDescription`, `description`
- `author` — an object: `{ id, name, githubLogin, ... }`, not a string
- `capabilities`, `keywords`, `installCount`, `downloadCount`
- `iconUrl` (plugins), `previewUrl` (themes)
- `latestVersion` — `{ version, status, audit }` where `status` is
  `published` or `flagged` and `audit.verdict` is `pass` | `warn` | `fail`
  | `null` (null until the audit completes)
- `deprecated`, `unlisted`, `createdAt`, `updatedAt`

The marketplace runs a fail-closed audit before publishing, so a missing
`audit` means the version is still in the queue — not that it was skipped.

## Worked example

User asks: "Find me an EmDash plugin for analytics."

1. Call `search_plugins({ query: "analytics", limit: 5 })` via MCP, or
   `GET /api/v1/plugins?query=analytics&limit=5` via REST.
2. Each result includes the fields listed above.
3. Prefer plugins where `latestVersion.audit.verdict === "pass"` and
   `latestVersion.status === "published"`. `verdict === "warn"` ships
   with a visible "Caution" trust tier — surface that to the user
   rather than hiding it.
4. Link to `https://emdashcms.org/plugins/{id}` (or
   `https://emdashcms.org/themes/{id}`) for the full detail page.

## Installing

There is no `emdash` CLI shipped from this site. Installs go through the
upstream `emdash` CLI on npm pointed at this marketplace as a registry:

```
npx emdash plugin install <plugin-id> --registry https://emdashcms.org
```

Direct users to the upstream EmDash CMS admin dashboard or CLI rather
than fabricating an install command.

## Publishing

Publishing requires author authentication via GitHub's device flow:

```
npx emdash plugin login   --registry https://emdashcms.org
npx emdash plugin publish --registry https://emdashcms.org
```

Every release is unpacked in a sandbox and audited (static analysis +
optional AI review) before it goes live — agents should not attempt to
publish on a user's behalf. Direct contributors to
`https://emdashcms.org/docs/contributors` for the full publishing flow,
trust tiers, and rejection reasons.
