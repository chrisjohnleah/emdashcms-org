# CLAUDE.md

This file is loaded into every Claude Code session. It contains behavioral rules, project context, and lessons learned.

## Principles

### 1. Public Repo Standards
- This is a public repository. Every commit, file, and comment is visible to anyone.
- Write code as if a senior engineer is reviewing your PR. No debug leftovers, no TODO hacks, no placeholder content.
- Conventional commits always (`feat:`, `fix:`, `chore:`, `test:`, `refactor:`, `docs:`).
- Never commit secrets, API keys, .env files, or anything that would be embarrassing if read by a stranger.
- Commit and push iteratively at each completed section — don't batch up work.

### 2. Verification Before Done
- Never mark a task complete without proving it works.
- Run `npm test` after code changes. Run `npm run build` before pushing.
- Ask yourself: "Would this pass code review?"
- If a fix feels hacky, implement the elegant solution instead.

### 3. Simplicity First
- Make every change as simple as possible. Minimal code, minimal abstraction.
- No ORM for 6 tables. No framework for 5 API routes. No library for something a function handles.
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Three similar lines of code is better than a premature abstraction.

### 4. Autonomous Problem Solving
- When given a bug or error: just fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests — then resolve them.
- If something goes sideways, stop and re-plan immediately — don't keep pushing.

## Project Context

A community-run plugin and theme marketplace for EmDash CMS at emdashcms.org. Implements the same API contract as the official (but undeployed) marketplace. Any EmDash installation can point at it via `createMarketplaceClient(baseUrl)`. Built entirely on Cloudflare's free tier. Goal: ship first, then offer the code upstream.

## Architecture

- **API**: Native Astro API routes (`export const GET/POST`). NOT Hono. File-based routing maps 1:1 to the MarketplaceClient contract.
- **Worker entry**: `src/worker.ts` exports `fetch` (Astro) + `queue` (audit pipeline) via `@astrojs/cloudflare/handler`.
- **Bindings**: `import { env } from 'cloudflare:workers'` everywhere. All pages use `export const prerender = false`.
- **Database**: Raw D1 SQL. Migrations in `migrations/`. Seed with `npm run db:seed`.
- **Testing**: `@cloudflare/vitest-pool-workers` — tests run in actual workerd runtime with real bindings.

## Stack

| Technology | Purpose |
|------------|---------|
| Astro 6 + @astrojs/cloudflare | SSR + API routes |
| Zod 4 (zod/mini) | Schema validation |
| jose | JWT signing/verification |
| modern-tar | Tarball parsing in Workers |
| D1 | Primary datastore |
| R2 | Artifact storage (zero egress) |
| KV | Read-heavy caching ONLY (1K writes/day — never use for counters) |
| Workers AI (`@cf/google/gemma-4-26b-a4b-it`) | Code audit |
| Cloudflare Queues | Async audit pipeline |
| Vitest + @cloudflare/vitest-pool-workers | Integration tests |
| Tailwind CSS 4 | UI styling |

## Key Rules

- **No Hono** — Astro routing is sufficient. Adding Hono is Anti-Pattern 1.
- **Rate limiting in D1, not KV** — KV has 1K writes/day (free tier). D1 has 100K.
- **Keyset cursor pagination** — base64 `(sort_column, id)` tuples, `LIMIT N+1`.
- **Fail-closed audit** — if AI audit errors, version is rejected. Never silently published.
- **Cost protection mandatory** — neuron cap + rate limits before any audit endpoint goes live.
- **10ms CPU limit** — all heavy work (tarball extraction, AI audit) must be async via Queues.

## Constraints (Cloudflare Free Tier)

| Resource | Limit |
|----------|-------|
| Workers requests | 100K/day |
| Workers CPU | 10ms/invocation |
| D1 reads | 5M/day |
| D1 writes | 100K/day |
| D1 storage | 5GB |
| R2 storage | 10GB |
| KV reads | 100K/day |
| KV writes | 1K/day |
| Workers AI | 10K neurons/day |
| Queues | 10K ops/day |

## Scripts

```bash
npm run dev           # astro dev
npm run dev:worker    # astro build && wrangler dev (tests custom worker entry)
npm run build         # wrangler types && astro check && astro build
npm test              # vitest run
npm run deploy        # astro build && wrangler deploy
npm run db:seed       # apply seeds/dev.sql to local D1
```

## Lessons Learned

- `wrangler types` must run after any `wrangler.jsonc` change — regenerates `worker-configuration.d.ts`.
- Custom `worker.ts` only works after `astro build` — dev requires `astro build && wrangler dev`.
- Use database name `emdashcms-org` (not binding name `DB`) in wrangler CLI commands.
- D1 `published_at` column is nullable but `MarketplaceVersionSummary.publishedAt` is non-nullable — always coalesce: `row.published_at ?? row.created_at`.
- `imageAuditVerdict` is always `null` until image audit is implemented (v2).
- All route files need `export const prerender = false` or Astro tries to prerender them.
- Queue `emdashcms-audit` must be created via `wrangler queues create emdashcms-audit` before first deploy.
