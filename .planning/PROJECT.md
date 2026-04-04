# EmDash CMS Community Marketplace

## What This Is

A community-run plugin and theme marketplace for EmDash CMS, deployed at emdashcms.org. Implements the exact same API contract as the official (but undeployed) marketplace, so any EmDash installation can point at it via `createMarketplaceClient(baseUrl)`. Built entirely on Cloudflare's free tier. The plan is to ship it first, then offer the code upstream to emdash-cms/emdash.

## Core Value

EmDash plugin authors have a working, secure marketplace to publish to and EmDash site owners can discover and install community plugins — before the official marketplace ships.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Plugin search and discovery API (GET /api/v1/plugins with query, category, capability, sort, cursor, limit)
- [ ] Plugin detail API (GET /api/v1/plugins/:id with full metadata, audit results, latest version)
- [ ] Plugin version history API (GET /api/v1/plugins/:id/versions)
- [ ] Plugin bundle download (GET /api/v1/plugins/:id/versions/:version/bundle — tarball from R2)
- [ ] Install tracking (POST /api/v1/plugins/:id/installs — fire-and-forget, non-identifying)
- [ ] Theme search and discovery API (GET /api/v1/themes with query, keyword, sort, cursor, limit)
- [ ] Theme detail API (GET /api/v1/themes/:id — metadata+links only, no bundle)
- [ ] Plugin registration (POST /api/v1/plugins — requires GitHub OAuth)
- [ ] Plugin version upload (POST /api/v1/plugins/:id/versions — multipart tarball, triggers audit)
- [ ] Audit retry (POST /api/v1/plugins/:id/versions/:version/retry-audit)
- [ ] GitHub OAuth for publisher authentication (web flow + device flow for CLI)
- [ ] Plugin manifest validation (Zod schema: id, version, capabilities, hooks, routes, storage, admin)
- [ ] Bundle validation before audit (10MB compressed max, 50MB decompressed, 200 files, 5MB per file)
- [ ] Workers AI code audit (@cf/qwen/qwq-32b with structured JSON output)
- [ ] Cost protection: rate limiting (5 versions/author/day via KV), daily neuron cap (8K/day via KV)
- [ ] D1 database schema (authors, plugins, plugin_versions, plugin_audits, installs, themes)
- [ ] R2 artifact storage (plugin bundles, theme thumbnails/screenshots)
- [ ] Public browsing UI (search, filter by capability, view plugin details)
- [ ] Publisher dashboard (manage plugins, view audit results, submit versions)

### Out of Scope

- Ratings/reviews — adds moderation burden, defer to v2
- Paid/commercial plugin hosting — legal complexity, defer
- Federation/decentralized registry — premature, no ecosystem yet
- On-chain anything — unnecessary complexity
- Full-text search — LIKE queries sufficient for v1 plugin count
- x402 payment protocol — interesting but not needed now
- Image audit — code audit is the priority; image audit can come later
- CLI tool — EmDash already has `emdash plugin publish`; we just need the API

## Context

EmDash CMS launched 2026-04-01 by Cloudflare. It's a TypeScript/Astro CMS with sandboxed plugins that declare capabilities in a manifest. The official repo (emdash-cms/emdash) contains marketplace code at packages/marketplace/ but it's not deployed — marketplace.emdashcms.com returns 404.

The CMS core includes a `MarketplaceClient` that takes any base URL, meaning alternative marketplaces are architecturally supported. This is our opening.

The official marketplace uses Hono, D1, R2, Workers AI, and GitHub OAuth. We're building a compatible implementation. If the EmDash team wants to merge our work or point their domain at it, the code should be clean enough to offer.

As of launch: 5,679 GitHub stars, 58 open issues, 6 contributors. The #1 community concern (per HN discussion, 677 points) is ecosystem/plugin availability.

Existing repo has: Astro 6 + Cloudflare adapter, D1/R2/KV bindings already created, Tailwind CSS 4, parked landing page.

## Constraints

- **Infrastructure**: Cloudflare free tier only — Workers (100K req/day, 10ms CPU), D1 (5M reads/day, 100K writes/day, 5GB), R2 (10GB, free egress), KV (100K reads/day, 1K writes/day), Workers AI (10K neurons/day)
- **API compatibility**: Must match the MarketplaceClient interface in packages/core/src/plugins/marketplace.ts exactly — response shapes, endpoint paths, query params
- **Public repo**: Everything visible. No secrets in code, no embarrassing artifacts, no sloppy commits
- **Cost protection**: Workers AI usage must be capped and rate-limited before any audit endpoint goes live
- **Security**: Fail-closed audit model — if audit fails/errors, version is rejected, never silently published

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Implement official API contract exactly | Compatibility with EmDash core MarketplaceClient | — Pending |
| Use Workers AI for code audit | Same model as official marketplace, pennies per audit | — Pending |
| GitHub OAuth for publisher identity | Matches official approach, ties to real identity | — Pending |
| Rate limit + neuron cap before enabling AI | Prevent abuse from running up Workers AI costs | — Pending |
| Astro SSR for browsing UI + API routes | Already scaffolded, dogfoods the ecosystem | — Pending |
| Offer code upstream after shipping | Build credibility, not competition | — Pending |
| Theme listings are metadata-only | No bundle needed — themes are Astro projects installed via npm/git | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-04 after initialization*
