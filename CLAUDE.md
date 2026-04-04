# Project Guide

## What This Is

A community-run plugin and theme marketplace for EmDash CMS, deployed at emdashcms.org. Implements the exact same API contract as the official (but undeployed) marketplace, so any EmDash installation can point at it via `createMarketplaceClient(baseUrl)`. Built entirely on Cloudflare's free tier.

**Core Value:** EmDash plugin authors have a working, secure marketplace to publish to and EmDash site owners can discover and install community plugins — before the official marketplace ships.

## Constraints

- **Infrastructure**: Cloudflare free tier only — Workers (100K req/day, 10ms CPU), D1 (5M reads/day, 100K writes/day, 5GB), R2 (10GB, free egress), KV (100K reads/day, 1K writes/day), Workers AI (10K neurons/day)
- **API compatibility**: Must match the MarketplaceClient interface from emdash-cms/emdash exactly — response shapes, endpoint paths, query params
- **Public repo**: Everything visible. No secrets in code, no embarrassing artifacts, no sloppy commits
- **Cost protection**: Workers AI usage must be capped and rate-limited before any audit endpoint goes live
- **Security**: Fail-closed audit model — if audit fails/errors, version is rejected, never silently published

## Architecture

- **API framework**: Native Astro API routes (`export const GET`, `export const POST`). NOT Hono. File-based routing maps 1:1 to the MarketplaceClient contract paths.
- **Custom worker entry**: `src/worker.ts` exports both `fetch` (Astro handler) and `queue` (audit pipeline) handlers via `@astrojs/cloudflare/handler`.
- **Bindings**: Access via `import { env } from 'cloudflare:workers'` in all route handlers.
- **All pages**: Use `export const prerender = false` for SSR (required for Cloudflare bindings).

## Technology Stack

| Technology | Purpose |
|------------|---------|
| Astro 6 + @astrojs/cloudflare | SSR framework with native API routes + browsing UI |
| TypeScript | Type safety throughout |
| Zod 4 (zod/mini) | Schema validation for manifests and requests |
| jose | JWT signing/verification for auth |
| modern-tar | Parse plugin .tar.gz bundles in Workers |
| D1 | Primary datastore (SQLite-based, free tier) |
| R2 | Artifact storage — plugin bundles, screenshots (zero egress) |
| KV | Read-heavy caching only (1K writes/day limit — do NOT use for counters) |
| Workers AI | Code audit (`@cf/google/gemma-4-26b-a4b-it`) |
| Cloudflare Queues | Async audit pipeline |
| Vitest + @cloudflare/vitest-pool-workers | Tests run in actual workerd runtime |
| Tailwind CSS 4 | UI styling |

## Key Decisions

- **No Hono**: Astro file-based routing is sufficient. Hono adds a redundant routing layer.
- **No ORM**: Raw D1 SQL. 6 tables don't justify Drizzle/Prisma overhead.
- **Rate limiting in D1, not KV**: KV has 1K writes/day on free tier — insufficient for counters. D1 has 100K writes/day.
- **Keyset cursor pagination**: Base64-encoded `(sort_column, id)` tuples with `LIMIT N+1` trick.
- **Audit model**: `@cf/google/gemma-4-26b-a4b-it` (MoE, 4B active params, 256K context, cheaper per audit than qwq-32b).

## Database

Migrations in `migrations/` directory. Apply locally: `wrangler d1 migrations apply emdashcms-org --local`. Apply to production: `wrangler d1 migrations apply emdashcms-org --remote`.

Seed data: `npm run db:seed` (applies `seeds/dev.sql`).

## Testing

```bash
npm test              # run all tests
npm run build         # wrangler types && astro check && astro build
npm run dev:worker    # astro build && wrangler dev (custom worker entry)
```

Tests use `@cloudflare/vitest-pool-workers` — real D1/R2/KV bindings, no mocking.

## Scripts

| Script | Command |
|--------|---------|
| `dev` | `astro dev` |
| `dev:worker` | `astro build && wrangler dev` |
| `build` | `wrangler types && astro check && astro build` |
| `test` | `vitest run` |
| `deploy` | `astro build && wrangler deploy` |
| `db:seed` | `wrangler d1 execute emdashcms-org --local --file=seeds/dev.sql` |
