<!-- GSD:project-start source:PROJECT.md -->
## Project

**EmDash CMS Community Marketplace**

A community-run plugin and theme marketplace for EmDash CMS, deployed at emdashcms.org. Implements the exact same API contract as the official (but undeployed) marketplace, so any EmDash installation can point at it via `createMarketplaceClient(baseUrl)`. Built entirely on Cloudflare's free tier. The plan is to ship it first, then offer the code upstream to emdash-cms/emdash.

**Core Value:** EmDash plugin authors have a working, secure marketplace to publish to and EmDash site owners can discover and install community plugins — before the official marketplace ships.

### Constraints

- **Infrastructure**: Cloudflare free tier only — Workers (100K req/day, 10ms CPU), D1 (5M reads/day, 100K writes/day, 5GB), R2 (10GB, free egress), KV (100K reads/day, 1K writes/day), Workers AI (10K neurons/day)
- **API compatibility**: Must match the MarketplaceClient interface in packages/core/src/plugins/marketplace.ts exactly — response shapes, endpoint paths, query params
- **Public repo**: Everything visible. No secrets in code, no embarrassing artifacts, no sloppy commits
- **Cost protection**: Workers AI usage must be capped and rate-limited before any audit endpoint goes live
- **Security**: Fail-closed audit model — if audit fails/errors, version is rejected, never silently published
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Decision: Hono for API, Astro for UI
- The official EmDash marketplace is pure Hono. Matching the framework means our route handlers, middleware, and validation patterns are structurally similar, making it trivial to diff against upstream or offer code back.
- Hono provides structured middleware chaining (auth, CORS, validation, rate limiting) that Astro API routes do not. Astro's `APIRoute` is a single function per endpoint with no middleware pipeline.
- Astro remains valuable for the browsing UI (SSR pages, Tailwind, islands) and is already scaffolded with the Cloudflare adapter.
- In Astro 6, Cloudflare bindings are accessed via `import { env } from 'cloudflare:workers'` -- this works inside Hono handlers too since they run in the same Worker.
- Hono's `app.fetch(request, env)` accepts the Worker env as a second argument, so bindings flow through `c.env` naturally. Inside the Astro catch-all route: `app.fetch(context.request, env)`.
## Recommended Stack
### HTTP Framework
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Hono | ^4.12 | API framework for `/api/v1/*` routes | Official marketplace uses Hono. Built-in middleware (CORS, bearer auth, JWT). 12KB tiny preset. Zero dependencies. First-class Cloudflare Workers support with typed bindings. Middleware chaining is essential for auth + validation + rate limiting pipeline. |
| Astro | ^6.1 | SSR browsing UI + static pages | Already scaffolded. SSR pages for plugin browsing, publisher dashboard. First-class Cloudflare Workers support in v6 with workerd dev server. |
| @astrojs/cloudflare | ^13.1 | Astro adapter for Workers | Already installed. Provides `cloudflare:workers` env import, workerd-based dev. |
### Validation
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| zod | ^4.3 (zod/mini) | Schema validation for manifests, requests | Official marketplace uses Zod. Zod 4 is 6.5x faster than v3. Use `zod/mini` for edge -- 85% smaller bundle (~2KB gzipped vs ~15KB). Functional API tree-shakes properly. |
| @hono/zod-validator | ^0.7 | Hono middleware for request validation | Validates `json`, `query`, `param`, `header` targets directly in middleware chain. Eliminates manual validation boilerplate. |
### Authentication
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| jose | ^6.2 | JWT signing/verification | Official marketplace uses jose. Zero dependencies. Works on all Web-interoperable runtimes including Cloudflare Workers. Uses Web Crypto API (no Node.js crypto dependency). Supports HS256, RS256, ES256 and more. |
- **Web flow** (browser publishers): Redirect to `github.com/login/oauth/authorize`, exchange code at `github.com/login/oauth/access_token`, fetch user from `api.github.com/user`. Standard 3-leg OAuth.
- **Device flow** (CLI `emdash plugin publish`): POST to `github.com/login/device/code`, display user code + verification URL, poll `github.com/login/oauth/access_token` with device code until authorized. Must enable device flow in GitHub OAuth app settings.
- **Session tokens:** After OAuth, mint a JWT with jose (sign with `HS256` using a Worker secret). Subsequent API calls pass `Authorization: Bearer <jwt>`. Hono's built-in JWT middleware or a custom middleware using jose verifies on every request.
- **Store author identity in D1:** On first OAuth, create author record (github_id, username, avatar_url). JWT payload includes `{ sub: github_id, username }`.
### Tarball Parsing
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| modern-tar | ^0.7 | Parse plugin .tar.gz bundles | Official marketplace uses modern-tar. Zero dependencies. Built for Web Streams API (not Node.js streams). Explicitly supports Cloudflare Workers. Provides `createGzipDecoder()` + `createTarDecoder()` for streaming decompression + extraction without buffering entire archive. |
### Database & Storage
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Cloudflare D1 | (binding) | Primary datastore | Free tier: 5M reads/day, 100K writes/day, 5GB. SQLite-based. Already bound as `DB`. Sufficient for a marketplace with <1000 plugins. |
| Cloudflare R2 | (binding) | Artifact storage (bundles, screenshots) | Free tier: 10GB storage, zero egress. Already bound as `ARTIFACTS`. Plugin tarballs stored here. |
| Cloudflare KV | (binding) | Rate limiting, caching | Free tier: 100K reads/day, 1K writes/day. Already bound as `CACHE`. Use for rate limit counters (5 versions/author/day), daily neuron cap tracking, and hot-path caching. |
- Migrations live in `migrations/` directory as numbered `.sql` files (e.g., `0001_initial_schema.sql`)
- Apply locally: `wrangler d1 migrations apply DB --local`
- Apply to production: `wrangler d1 migrations apply DB --remote`
- Wrangler tracks applied migrations in a `d1_migrations` table automatically
- If a migration fails, it rolls back -- the previous state is preserved
- Use `PRAGMA defer_foreign_keys = true` when migrations modify foreign key relationships
### AI Integration
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Workers AI | (binding: `@cf/qwen/qwq-32b`) | Code audit for plugin submissions | Official marketplace uses same model. 24K token context window. Free tier: 10,000 neurons/day. Pricing beyond free: $0.66/M input tokens, $1.00/M output tokens. |
- Track daily neuron usage in KV (increment per audit, reset at UTC midnight)
- Hard cap at ~8,000 neurons/day to leave headroom
- Rate limit: max 5 version submissions per author per day (also KV)
- If cap exceeded, return 503 with `Retry-After` header -- never silently skip audits
### Infrastructure & Tooling
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Wrangler | ^4.80 | CLI for dev, deploy, D1 migrations | Official Cloudflare CLI. Astro 6 + @astrojs/cloudflare use it under the hood. |
| TypeScript | ^5.7 | Type safety | Required by Astro 6 (Node 22+). Hono has first-class TS support with typed bindings. |
| Tailwind CSS | ^4.2 | UI styling | Already installed. Used for browsing UI and publisher dashboard. |
### Testing
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Vitest | ^4.1 | Test runner | Required by @cloudflare/vitest-pool-workers. Vitest 4.1 requires Vite >= 6.0 and Node >= 20. |
| @cloudflare/vitest-pool-workers | ^0.13 | Run tests inside workerd runtime | Tests execute in the actual Workers runtime with real D1, R2, KV bindings (local miniflare). No mocking storage layers. Apply D1 migrations in test setup via `applyD1Migrations()`. |
- **Unit tests:** Validate Zod schemas, utility functions, JWT logic. Run in workerd via vitest-pool-workers.
- **Integration tests:** Hit Hono routes with real D1/R2/KV bindings. Use `SELF.fetch()` from the test pool. Apply migrations before each test suite. Each test file gets isolated storage.
- **No e2e browser tests for v1.** The API is the product -- test it thoroughly. UI is secondary.
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| API framework | Hono | Pure Astro API routes | No middleware pipeline. Each route is an isolated function -- auth, validation, CORS repeated per endpoint. Fine for 2 routes, not 12+. |
| API framework | Hono | Express/Fastify | Not designed for edge. Depend on Node.js APIs unavailable in Workers. |
| Validation | zod/mini | Full zod | ~15KB bundle vs ~2KB. Same API shape, worse tree-shaking. |
| Validation | zod/mini | Valibot | Smaller bundle (1.4KB), but official marketplace uses Zod. Compatibility > marginal size win. |
| JWT | jose | @tsndr/cloudflare-worker-jwt | jose is more complete (JWE, JWK, JWKS), battle-tested, used by official marketplace. cloudflare-worker-jwt is simpler but less maintained. |
| Tarball | modern-tar | node-tar | node-tar depends on Node.js fs/streams -- does not run in Workers. Has known CVEs in 2026. |
| Tarball | modern-tar | tar-stream | Node.js streams, not Web Streams. Would need polyfill shims in Workers. |
| ORM | None (raw D1 SQL) | Drizzle | Added complexity, migration tooling conflicts with Wrangler's built-in migrations, bundle bloat. 6 tables don't justify an ORM. |
| ORM | None (raw D1 SQL) | Prisma | Does not support D1. |
| Auth | Manual OAuth + jose | better-auth | Heavier abstraction. We need exactly two flows (web + device). Manual implementation is ~200 lines total and fully transparent. |
| Testing | @cloudflare/vitest-pool-workers | Miniflare standalone | vitest-pool-workers supersedes standalone miniflare for testing. Same engine, better DX with Vitest APIs. |
## Installation
# Core API dependencies
# Already installed (Astro + Cloudflare)
# astro @astrojs/cloudflare
# Dev dependencies
## Project Structure
## Key Integration Pattern: Astro + Hono
## Sources
- [Hono - Cloudflare Workers getting started](https://hono.dev/docs/getting-started/cloudflare-workers) -- HIGH confidence
- [Hono npm (v4.12.10)](https://www.npmjs.com/package/hono) -- version confirmed
- [Astro Cloudflare integration docs](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) -- HIGH confidence
- [Astro 6.0 release blog](https://astro.build/blog/astro-6/) -- HIGH confidence
- [modern-tar GitHub](https://github.com/ayuhito/modern-tar) -- HIGH confidence
- [jose GitHub](https://github.com/panva/jose) -- HIGH confidence
- [Zod v4 release notes](https://zod.dev/v4) -- HIGH confidence
- [Zod Mini docs](https://zod.dev/packages/mini) -- HIGH confidence
- [@hono/zod-validator npm](https://www.npmjs.com/package/@hono/zod-validator) -- HIGH confidence
- [D1 migrations docs](https://developers.cloudflare.com/d1/reference/migrations/) -- HIGH confidence
- [D1 and Hono example](https://developers.cloudflare.com/d1/examples/d1-and-hono/) -- HIGH confidence
- [Workers AI QwQ-32B model](https://developers.cloudflare.com/workers-ai/models/qwq-32b/) -- HIGH confidence
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) -- HIGH confidence
- [Vitest integration for Workers](https://developers.cloudflare.com/workers/testing/vitest-integration/) -- HIGH confidence
- [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) -- HIGH confidence
- [Elysia vs Hono in Astro + Cloudflare](https://afonsojramos.me/blog/elysia-vs-hono-astro-cloudflare/) -- MEDIUM confidence (blog post, but code patterns verified)
- [Hono + Astro integration guide](https://nuro.dev/posts/how_to_use_astro_with_hono/) -- MEDIUM confidence
- [Cloudflare Workers free tier limits](https://developers.cloudflare.com/workers/platform/limits/) -- HIGH confidence
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
