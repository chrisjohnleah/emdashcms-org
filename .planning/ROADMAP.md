# Roadmap: EmDash CMS Community Marketplace

## Overview

This roadmap delivers a fully functional community plugin and theme marketplace for EmDash CMS, API-compatible with the official (but undeployed) MarketplaceClient. The journey moves from data foundation through read API, authentication, publishing, AI audit, downloads, and into two UI layers (public browsing and publisher dashboard), finishing with theme listings. Phases 10-11 add GitHub App integration (auto-publish on release) and team/collaborator access (multi-owner plugin management) as post-core enhancements. The browsing UI (Phase 7) can execute in parallel with Phases 3-6 since it depends only on the read API. Every phase delivers a coherent, independently verifiable capability running entirely on Cloudflare's free tier.

Milestone **v1.1 — Signals & Reach** (Phases 12-17) turns the working marketplace into a compounding ecosystem: it closes the critical publisher feedback loop, creates growth loops that accrue SEO and distribution inventory over time, and prepares the artifacts needed for the upstream handoff conversation with the EmDash core team. Every v1.1 phase is independent — they can execute in any order or in parallel.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation and Data Layer** - D1 schema, custom worker entry, API contract types, migration tooling, and integration test harness
- [ ] **Phase 2: Read-Only Discovery API** - GET endpoints for plugin search, plugin detail, version history, theme search, and theme detail
- [ ] **Phase 3: Authentication** - GitHub OAuth (web + device flow), auth middleware, signed session cookies
- [ ] **Phase 4: Plugin Publishing Pipeline** - Plugin registration, version upload, manifest/bundle validation, R2 storage, queue submission, rate limiting
- [ ] **Phase 5: AI Audit Pipeline** - Workers AI code audit, structured findings, neuron budget cap, fail-closed model, retry workflow
- [ ] **Phase 6: Bundle Downloads and Install Tracking** - R2 bundle serving, install count tracking, API rate limiting
- [x] **Phase 7: Browsing UI** - Public SSR pages for plugin search, plugin detail, and theme browsing (completed 2026-04-05)
- [ ] **Phase 8: Publisher Dashboard** - Authenticated UI for plugin management, audit results, version submission
- [x] **Phase 9: Theme Listings** - Theme submission, screenshot uploads, theme browsing pages (completed 2026-04-05)
- [x] **Phase 10: GitHub App Integration** - Auto-publish on GitHub release, repo-scoped webhook, private repo support (gap closure in progress) (completed 2026-04-05)
- [ ] **Phase 11: Team & Collaborator Access** - Multi-owner plugin management, invitation flow, role-based permissions

### Milestone v1.1 — Signals & Reach

- [ ] **Phase 12: Publisher Notifications** - Audit outcome, report, and revocation notifications via GitHub repo comments, outbound webhooks, and Queue-backed delivery with retries
- [ ] **Phase 13: README Badges** - Edge-cached SVG badge endpoints for installs, version, trust tier, audit verdict, and EmDash compatibility, plus copy-paste embed snippets
- [ ] **Phase 14: Feeds and Weekly Digest** - Atom feeds for new/updated plugins and themes, per-category feeds, and Cron-generated weekly digest pages as permanent SEO inventory
- [ ] **Phase 15: Transparency Report and Status Page** - Weekly aggregated marketplace metrics and live uptime samples for the core public surfaces
- [ ] **Phase 16: AI and Social Discoverability** - llms.txt index, Schema.org JSON-LD on detail pages, Open Graph image generation, and sitemap.xml for plugin, theme, category, hook, and digest pages
- [ ] **Phase 17: Deprecation and Unlist Self-Service** - Publisher-initiated graceful sunset with reason and successor linking, deprecation banners, demoted ranking, and CLI-facing warnings via install tracking

## Phase Details

### Phase 1: Foundation and Data Layer
**Goal**: Every component has a stable data layer and typed API contract to build against
**Depends on**: Nothing (first phase)
**Requirements**: FOUN-01, FOUN-02, FOUN-03, FOUN-04, FOUN-05
**Success Criteria** (what must be TRUE):
  1. D1 database with all 6 tables (authors, plugins, plugin_versions, plugin_audits, installs, themes) is created via versioned migrations and queryable in dev
  2. Custom worker.ts entry point boots Astro and exports both fetch and queue handler skeletons without errors
  3. TypeScript types matching the MarketplaceClient contract from emdash-cms/emdash are defined and used by at least one integration test that validates response shapes
  4. Wrangler dev starts successfully with all bindings (D1, R2, KV, Queue, AI) available in the local environment
**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md — Infrastructure, D1 schema, custom worker.ts, MarketplaceClient types
- [x] 01-02-PLAN.md — Integration tests validating all FOUN requirements + wrangler dev boot verification

### Phase 2: Read-Only Discovery API
**Goal**: Any EmDash installation can discover plugins and themes via the public API
**Depends on**: Phase 1
**Requirements**: DISC-01, DISC-02, DISC-03, DISC-04, DISC-05
**Success Criteria** (what must be TRUE):
  1. GET /api/v1/plugins returns paginated results with working query, category, capability, and sort parameters against seed data
  2. GET /api/v1/plugins/:id returns full plugin detail including author, capabilities, latest version, audit verdict, and risk score
  3. GET /api/v1/plugins/:id/versions returns version history with status, changelog, and audit results
  4. GET /api/v1/themes returns paginated results with working query, keyword, and sort parameters
  5. GET /api/v1/themes/:id returns full theme detail with metadata, screenshots, and repository links
**Plans:** 3 plans

Plans:
- [x] 02-01-PLAN.md — Schema alignment migration, seed data, shared query/mapper/pagination/response helpers
- [x] 02-02-PLAN.md — Plugin search, detail, and version history endpoints + integration tests
- [x] 02-03-PLAN.md — Theme search and detail endpoints + integration tests

### Phase 3: Authentication
**Goal**: Publishers can prove their identity via GitHub before accessing any write operation
**Depends on**: Phase 1
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04
**Success Criteria** (what must be TRUE):
  1. Publisher can complete GitHub OAuth web flow in the browser and land on an authenticated page showing their GitHub username
  2. Publisher can complete GitHub OAuth device flow from a terminal by entering a code at github.com/login/device
  3. Unauthenticated requests to write endpoints (publish, manage, retry-audit) receive 401 responses
  4. Authenticated sessions persist across browser refreshes via signed cookies with no server-side session storage
**Plans:** 2 plans

Plans:
- [x] 03-01-PLAN.md — Auth core: install jose, configure secrets, create auth library (jwt, github, session) with unit tests
- [x] 03-02-PLAN.md — Auth routes, middleware, dashboard placeholder, and protection tests

### Phase 4: Plugin Publishing Pipeline
**Goal**: Authenticated publishers can submit plugins that are validated and queued for audit
**Depends on**: Phase 1, Phase 3
**Requirements**: PUBL-01, PUBL-02, PUBL-03, PUBL-04, PUBL-05, PUBL-06, COST-01, COST-03
**Success Criteria** (what must be TRUE):
  1. Authenticated publisher can register a new plugin via POST /api/v1/plugins and see it appear in the read API
  2. Authenticated publisher can upload a version tarball that passes manifest validation (Zod schema) and bundle constraints (10MB compressed, 50MB decompressed, 200 files, 5MB/file), gets stored in R2, and creates a "pending" version record
  3. Invalid submissions (bad manifest, oversized bundle, malformed tarball) are rejected with structured error messages before any audit processing
  4. Valid uploads enqueue an audit job via Cloudflare Queues and return 202 immediately
  5. Publisher who has uploaded 5 versions in a day receives a rate limit error on the 6th attempt
**Plans:** 3 plans

Plans:
- [x] 04-01-PLAN.md — D1 migration, manifest Zod/mini schema, bundle validator with modern-tar, timestamp utility, unit tests
- [x] 04-02-PLAN.md — Publishing queries, R2 storage, queue helper, route handlers (POST plugins, POST versions, POST retry-audit)
- [x] 04-03-PLAN.md — Integration tests for all publishing flows + full test suite and build verification

### Phase 5: AI Audit Pipeline
**Goal**: Every uploaded plugin version receives an automated security audit that determines its publication status
**Depends on**: Phase 4
**Requirements**: AUDT-01, AUDT-02, AUDT-03, AUDT-04, COST-02
**Success Criteria** (what must be TRUE):
  1. Queue consumer processes pending audit jobs and calls Workers AI (gemma-4-26b) with structured JSON output containing verdict, risk score, and individual findings
  2. Audit results update version status correctly: pass leads to published, warn leads to flagged, fail leads to rejected
  3. Audit findings are stored in D1 with verdict, risk score, severity, title, description, category, and location -- visible via the version detail API
  4. If audit errors or times out, the version is rejected (never silently published) -- fail-closed model verified
  5. Daily neuron budget tracked in D1 hard-stops audit processing when 8K neurons/day exceeded, and publisher can retry a failed audit without re-uploading
**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md — D1 migration, audit library modules (budget, prompt, queries, consumer), worker.ts queue consumer
- [x] 05-02-PLAN.md — Integration tests for all audit pipeline flows with mock AI binding

### Phase 6: Bundle Downloads and Install Tracking
**Goal**: EmDash site owners can download published plugins and the marketplace tracks usage
**Depends on**: Phase 5
**Requirements**: DOWN-01, DOWN-02, DOWN-03, COST-04
**Success Criteria** (what must be TRUE):
  1. GET /api/v1/plugins/:id/versions/:version/bundle streams the tarball from R2 with correct Content-Type and Content-Disposition headers, only for published versions (non-published returns 404)
  2. POST /api/v1/plugins/:id/installs accepts fire-and-forget install tracking with site hash and version, returns 202, and is non-identifying
  3. Install counts appear on plugin detail and search result responses
  4. Search and download endpoints enforce rate limiting to stay within 100K Workers requests/day free tier
**Plans:** 2 plans

Plans:
- [x] 06-01-PLAN.md — Migration, download/install/rate-limit query libraries, rate limit middleware integration
- [x] 06-02-PLAN.md — Bundle download and install tracking API routes + integration tests for all requirements

### Phase 7: Browsing UI
**Goal**: Anyone with a browser can discover plugins and themes without using the API directly
**Depends on**: Phase 2 (can run in parallel with Phases 3-6)
**Requirements**: DISC-06, DISC-07, DISC-08
**Success Criteria** (what must be TRUE):
  1. Browsing UI renders a searchable plugin listing page with working search input and capability/category filters
  2. Plugin detail page displays plugin metadata, audit verdict with risk score, version history, and an install button/instructions
  3. Theme listing and detail pages render with metadata, preview images, and repository links
**Plans:** 3/3 plans complete

Plans:
- [x] 07-01-PLAN.md — Shared BaseLayout, reusable UI components (badges, cards, search, filters, pagination, empty states), landing page CTAs
- [x] 07-02-PLAN.md — Plugin listing page with search/filter/sort/pagination and plugin detail page with audit/versions/install command
- [x] 07-03-PLAN.md — Theme listing page with search/keyword-filter/sort and theme detail page with metadata/preview

### Phase 8: Publisher Dashboard
**Goal**: Plugin authors have a home base to manage their plugins and understand audit results
**Depends on**: Phase 3, Phase 5, Phase 7
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04
**Success Criteria** (what must be TRUE):
  1. Authenticated publisher sees a dashboard listing their plugins with current status (published, pending, flagged, rejected) for each
  2. Publisher can drill into any version to see full audit results: verdict, risk score, and individual findings with severity, category, and code location
  3. Publisher can submit a new version from the dashboard and see it move through pending to published/flagged/rejected
  4. Publisher can edit plugin metadata (description, keywords, links) from the dashboard
**Plans:** 3 plans

Plans:
- [x] 08-01-PLAN.md — Backend: DashboardBanner component, query/mapper/mutation functions, PATCH endpoint, unit tests
- [x] 08-02-PLAN.md — Dashboard home (plugin table), plugin registration form, plugin detail page (metadata edit + version table)
- [x] 08-03-PLAN.md — Version upload page (multipart form + direct function calls) and audit detail page (verdict, findings, retry)

### Phase 9: Theme Listings
**Goal**: Theme authors can list their themes and site owners can discover them alongside plugins
**Depends on**: Phase 3, Phase 7
**Requirements**: THEM-01, THEM-02, THEM-03
**Success Criteria** (what must be TRUE):
  1. Authenticated publisher can submit a theme listing with name, description, preview URL, repository URL, keywords, and license via the API
  2. Theme listings support thumbnail and screenshot uploads stored in R2, displayed on theme detail pages
  3. Theme browsing UI renders listing and detail pages with metadata, images, and repository links
**Plans:** 2/2 plans complete

Plans:
- [x] 09-01-PLAN.md — Backend: D1 migration, theme query functions, image storage utilities, API endpoints (POST/PATCH themes, image proxy), mapper updates, tests
- [x] 09-02-PLAN.md — Dashboard pages (theme list, register, edit with image upload), dashboard home update, ThemeCard thumbnail, screenshot gallery on detail page

### Phase 10: GitHub App Integration
**Goal**: Publishers can connect a GitHub repo and have new versions automatically submitted when they cut a release
**Depends on**: Phase 4
**Requirements**: GHAP-01, GHAP-02, GHAP-03, GHAP-04
**Success Criteria** (what must be TRUE):
  1. Publisher can install the emdashcms GitHub App on a specific repository with scoped permissions (contents:read only)
  2. When a GitHub release is published on a connected repo, a webhook triggers automatic tarball download, validation, and audit queue submission
  3. Private repositories work — the GitHub App's installation token provides secure, repo-scoped access without broad OAuth permissions
  4. Publisher can configure which branch/release tag pattern triggers submissions, and can disconnect the integration at any time
**Plans:** 4/4 plans complete

Plans:
- [x] 10-01-PLAN.md — D1 migration (github_installations, plugin_github_links, version source), GitHub library modules (RS256 JWT, HMAC webhook verify, installation tokens, D1 queries), unit tests
- [x] 10-02-PLAN.md — Webhook endpoint (POST /api/v1/webhooks/github), middleware exemptions (CSRF, rate limit), release filtering, full pipeline integration tests
- [x] 10-03-PLAN.md — Installation callback, repo listing endpoint, SourceBadge component, dashboard GitHub sections on plugin/theme detail pages
- [x] 10-04-PLAN.md — Gap closure: tag pattern column, matchesTagPattern function, webhook pattern check, dashboard tag pattern UI

### Phase 11: Team & Collaborator Access
**Goal**: Multiple people can manage a plugin with appropriate role-based permissions
**Depends on**: Phase 3, Phase 4
**Requirements**: TEAM-01, TEAM-02, TEAM-03, TEAM-04
**Success Criteria** (what must be TRUE):
  1. Plugin owner can invite collaborators by GitHub username, and invitees receive notification via the dashboard
  2. Collaborators table supports three roles: owner (full control), maintainer (upload versions, edit metadata), contributor (view audit results only)
  3. All write endpoints enforce role-based access — maintainers can upload versions but cannot transfer ownership or delete the plugin
  4. Plugin owner can revoke collaborator access at any time, and ownership can be transferred to another collaborator
**Plans:** 2/3 plans executed

Plans:
- [x] 11-01-PLAN.md — D1 migration (collaborators + invites tables), permissions helper (checkPluginAccess, role hierarchy), collaborator query module (invite CRUD, transfer, delete, dashboard queries), RoleBadge component, unit tests
- [x] 11-02-PLAN.md — RBAC retrofit of all write endpoints (4 API routes + 4 dashboard pages) replacing getPluginOwner/getThemeOwner with checkPluginAccess, role-aware dashboard rendering, integration tests
- [ ] 11-03-PLAN.md — Dashboard UI: pending invitations section, role badges on plugin/theme lists, team management section on detail pages (invite, role change, remove), ownership transfer and deletion with confirmation

---

## Milestone v1.1 — Signals & Reach

Phases 12-17 form the second milestone. They are intentionally independent: each one ships value on its own and none blocks any other, so Christopher can sequence them by priority rather than dependency. Milestone v1.0 should complete (Phase 11-03) before v1.1 execution begins, but v1.1 discussion and planning can start in parallel.

### Phase 12: Publisher Notifications
**Goal**: Every publisher automatically learns about events affecting their plugins without having to log in
**Depends on**: Phase 5 (audit), Phase 10 (GitHub App), Phase 15-reports (existing reports system)
**Requirements**: NOTF-01, NOTF-02, NOTF-03, NOTF-04, NOTF-05
**Success Criteria** (what must be TRUE):
  1. When a version's audit completes (pass, warn, fail, error), the plugin owner and any maintainer collaborators are notified via every channel they have enabled
  2. When a report is filed against a plugin or theme, the owner receives a notification with the report category and a link to the detail page
  3. When a moderator revokes a version or plugin, the owner receives a notification including the public admin note (if set)
  4. Publisher can configure notification preferences and an outbound webhook URL from the dashboard settings page; changes persist in D1
  5. For repos linked via the GitHub App, notifications can post a comment on the GitHub release (or open an issue if no matching release); for publishers without a linked repo, outbound webhook delivery is the primary channel
  6. Notification delivery runs through a Cloudflare Queue with exponential backoff, at-most-once delivery semantics, and dead-lettering after a bounded retry budget
**Plans:** 3 plans

Plans:
- [ ] 12-01-PLAN.md — D1 migration (notification_preferences, notification_deliveries), notification library modules (channels, queue payload types, GitHub comment/issue helpers, webhook signer), unit tests
- [ ] 12-02-PLAN.md — Notification emitter hooks in audit consumer, report submission flow, and admin revoke/ban endpoints; Queue consumer for delivery with retry + DLQ
- [ ] 12-03-PLAN.md — Dashboard notification settings page (channel toggles, webhook URL form, test-send button), per-author notification history view, integration tests

### Phase 13: README Badges
**Goal**: Every plugin page offers copy-paste shields that publishers embed in their READMEs, creating permanent inbound links and trust surfaces
**Depends on**: Phase 2 (read API), Phase 5 (audit verdict)
**Requirements**: BADG-01, BADG-02, BADG-03, BADG-04, BADG-05
**Success Criteria** (what must be TRUE):
  1. Public endpoints serve SVG badges for installs, latest version, trust tier, audit verdict, and EmDash compatibility under `/badges/v1/plugin/[id]/[metric].svg`, each with a correct `Content-Type: image/svg+xml` and long-lived edge cache headers
  2. Badge content reflects current plugin state within 1 hour of a change (installs) and immediately on revoke/version/trust-tier changes (via purge)
  3. Plugin detail and dashboard pages display a "Embed in README" panel with one-click copy buttons for markdown and HTML snippets
  4. Badges are served from Cloudflare's edge cache on repeat requests (verified via `CF-Cache-Status` header in tests) and consume at most one D1 read per cache miss
  5. Badge endpoints enforce per-IP rate limiting to prevent amplification and are exempt from CSRF but require no authentication
**Plans:** 2 plans

Plans:
- [ ] 13-01-PLAN.md — Badge library (SVG template, hand-rolled layout, metric-to-color mapping), badge route handler with edge caching, purge helper triggered on revoke/version/trust changes, unit tests
- [ ] 13-02-PLAN.md — Plugin detail "Embed in README" panel, dashboard badge preview section, integration tests covering cache headers and purge behavior

### Phase 14: Feeds and Weekly Digest
**Goal**: Every consumer, bot, and AI agent can subscribe to marketplace activity via open standards, and every week becomes a permanent indexable SEO page
**Depends on**: Phase 2 (read API)
**Requirements**: FEED-01, FEED-02, FEED-03, FEED-04, FEED-05, FEED-06, FEED-07
**Success Criteria** (what must be TRUE):
  1. `/feeds/plugins/new.xml` and `/feeds/plugins/updated.xml` serve valid Atom 1.0 feeds listing the 50 most recent entries with author, summary, and canonical link
  2. `/feeds/themes/new.xml` serves the equivalent for themes
  3. `/feeds/plugins/category/[category].xml` serves per-category Atom feeds; unknown categories return 404
  4. A weekly Cron worker runs every Sunday 00:05 UTC, computes the ISO week's new and updated items, and writes a digest row to D1
  5. `/digest/YYYY-Www` renders the archived digest page for any past week (permanent URL), and `/digest` lists all prior digests sorted newest first
  6. `robots.txt` advertises feed URLs and the BaseLayout `<link rel="alternate" type="application/atom+xml">` tags expose them to feed readers
**Plans:** 2 plans

Plans:
- [ ] 14-01-PLAN.md — D1 migration (weekly_digests table), feed library (Atom XML builder, date formatters, canonical URL helpers), feed route handlers for plugins/themes/category, unit tests
- [ ] 14-02-PLAN.md — Weekly digest Cron handler wired into worker.ts scheduled handler, `/digest/YYYY-Www` and `/digest` pages, BaseLayout feed discovery tags, robots.txt update, integration tests

### Phase 15: Transparency Report and Status Page
**Goal**: The marketplace publicly demonstrates it is policing itself, giving consumers confidence and giving the EmDash core team the strongest possible artifact for the upstream handoff conversation
**Depends on**: Phase 5 (audit metrics), Phase 6 (install metrics), reports system
**Requirements**: TRNS-01, TRNS-02, TRNS-03, TRNS-04, TRNS-05
**Success Criteria** (what must be TRUE):
  1. `/transparency` renders the latest weekly snapshot showing: versions submitted, published, flagged, rejected, revoked, reports filed by category, reports resolved, and anonymized Workers AI neuron spend
  2. A weekly Cron worker computes the metrics and writes one row to a `transparency_weeks` table; historical weeks are navigable via the transparency page
  3. `/status` renders a live uptime strip for the last 7 days showing samples for: landing page, plugins list, plugin detail, bundle download, publishing API
  4. A periodic Cron worker (every 5 minutes) pings the tracked surfaces and writes samples to a `status_samples` table with 7-day rolling retention enforced on every write
  5. Neither the transparency page nor status page identifies individual plugins, authors, or reporters — all metrics are aggregates
**Plans:** 2 plans

Plans:
- [ ] 15-01-PLAN.md — D1 migration (transparency_weeks, status_samples), metrics aggregation library (audit stats, report stats, neuron spend sums), status probe library, Cron handlers, unit tests
- [ ] 15-02-PLAN.md — `/transparency` and `/status` pages with historical navigation, BaseLayout footer links, integration tests verifying anonymization and rolling retention

### Phase 16: AI and Social Discoverability
**Goal**: The marketplace is trivially crawlable by AI search (Claude, Perplexity, ChatGPT, Google AI Overviews) and every plugin share on social platforms renders with a rich preview
**Depends on**: Phase 2 (read API), Phase 7 (detail pages)
**Requirements**: AIDX-01, AIDX-02, AIDX-03, AIDX-04, AIDX-05, AIDX-06, AIDX-07, AIDX-08
**Success Criteria** (what must be TRUE):
  1. `/llms.txt` at the site root serves a machine-readable index of the marketplace with a one-line summary per featured plugin, following the llms.txt convention
  2. Plugin detail pages embed a `<script type="application/ld+json">` block with Schema.org `SoftwareApplication` markup matching visible content (name, author, version, applicationCategory, softwareRequirements, aggregateRating if reviews exist)
  3. Theme detail pages embed Schema.org `CreativeWork` markup and the site root embeds `Organization` markup
  4. `/og/plugin/[id].png` generates a branded Open Graph image on first request, stores it in R2 keyed by plugin id + latest version, and serves from R2 on subsequent requests
  5. `/og/theme/[id].png` does the same for themes
  6. BaseLayout sets `og:image` on plugin and theme detail pages to the generated image URL, with width/height meta
  7. `/sitemap.xml` lists plugin detail, theme detail, category, hook browse pages, and digest archive pages with accurate `<lastmod>` values; `robots.txt` references the sitemap
**Plans:** 3 plans

Plans:
- [ ] 16-01-PLAN.md — llms.txt generator route, JSON-LD builder for SoftwareApplication/CreativeWork/Organization, BaseLayout integration, unit tests validating schema shapes
- [ ] 16-02-PLAN.md — OG image generator library (satori + resvg-wasm or equivalent Workers-compatible renderer), `/og/plugin/[id].png` and `/og/theme/[id].png` routes with R2 caching, purge on new version, integration tests
- [ ] 16-03-PLAN.md — `/sitemap.xml` generator with keyset pagination for large catalogs, robots.txt sitemap directive, plugin/theme meta tag updates, integration tests

### Phase 17: Deprecation and Unlist Self-Service
**Goal**: Publishers can gracefully sunset plugins, warn users to migrate, and recommend successors — closing the single biggest UX failure of legacy registries before it takes root
**Depends on**: Phase 4 (publishing), Phase 6 (install tracking response shape)
**Requirements**: DEPR-01, DEPR-02, DEPR-03, DEPR-04, DEPR-05, DEPR-06, DEPR-07, DEPR-08
**Success Criteria** (what must be TRUE):
  1. Authenticated plugin owner can mark their plugin as deprecated via the dashboard with a required reason and optional successor plugin id; the change is atomic and audit-logged
  2. Deprecated plugin detail pages render a prominent warning banner with the reason and (if set) a link to the successor; the banner is visible to anonymous visitors
  3. Deprecated plugins are demoted in the default search sort but still appear in results and remain downloadable so existing installs continue to function
  4. `POST /api/v1/plugins/:id/installs` response includes a `deprecationWarning` field when the plugin is deprecated, suitable for the EmDash CLI to display on next install
  5. Successor selection rejects any successor that is itself deprecated and prevents cycles (A→B→A) via a pre-write check
  6. Owner can un-deprecate a plugin and can separately unlist a plugin (hides from search and category pages but keeps direct links and downloads working)
  7. Plugin cards and list rows show a visible "Deprecated" chip on deprecated plugins so consumers never adopt them by accident
**Plans:** 3 plans

Plans:
- [ ] 17-01-PLAN.md — D1 migration (deprecated_at, deprecated_reason, successor_id, unlisted_at columns on plugins table), deprecation query functions with cycle check, search/sort demotion logic, mapper updates, unit tests
- [ ] 17-02-PLAN.md — Dashboard UI (deprecate/unlist forms with successor picker and confirmation), plugin detail page banner, plugin card deprecation chip, install tracking response update
- [ ] 17-03-PLAN.md — Integration tests for cycle detection, search demotion, download still works when deprecated, install tracking warning field, unlist visibility rules

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> (v1.1) 12 -> 13 -> 14 -> 15 -> 16 -> 17
Note: Phase 7 (Browsing UI) can execute in parallel with Phases 3-6 since it only depends on Phase 2.
Note: Phases 10-11 are post-v1 enhancements — can ship v1 without them.
Note: Phases 12-17 form Milestone v1.1 "Signals & Reach". They are independent of each other and can ship in any order; recommended sequence is 12 (unblocks publishers) → 13 (cheapest growth loop) → 14 (SEO compounding) → 15 (upstream narrative) → 16 (AI/social reach) → 17 (ecosystem hygiene).

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation and Data Layer | 2/2 | Complete | 2026-04-04 |
| 2. Read-Only Discovery API | 3/3 | Complete | 2026-04-04 |
| 3. Authentication | 2/2 | Complete | 2026-04-04 |
| 4. Plugin Publishing Pipeline | 0/3 | Not started | - |
| 5. AI Audit Pipeline | 0/2 | Not started | - |
| 6. Bundle Downloads and Install Tracking | 0/2 | Not started | - |
| 7. Browsing UI | 3/3 | Complete   | 2026-04-05 |
| 8. Publisher Dashboard | 0/3 | Not started | - |
| 9. Theme Listings | 2/2 | Complete   | 2026-04-05 |
| 10. GitHub App Integration | 4/4 | Complete    | 2026-04-05 |
| 11. Team & Collaborator Access | 2/3 | In Progress|  |
| 12. Publisher Notifications | 0/3 | Not started | - |
| 13. README Badges | 0/2 | Not started | - |
| 14. Feeds and Weekly Digest | 0/2 | Not started | - |
| 15. Transparency Report and Status Page | 0/2 | Not started | - |
| 16. AI and Social Discoverability | 0/3 | Not started | - |
| 17. Deprecation and Unlist Self-Service | 0/3 | Not started | - |
