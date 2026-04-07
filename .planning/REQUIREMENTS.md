# Requirements: EmDash CMS Community Marketplace

**Defined:** 2026-04-04
**Core Value:** EmDash plugin authors have a working, secure marketplace to publish to and site owners can discover and install community plugins

## v1 Requirements

### Foundation

- [x] **FOUN-01**: D1 database schema supports authors, plugins, plugin_versions, plugin_audits, installs, and themes tables
- [x] **FOUN-02**: Custom worker.ts entry point exports both fetch (Astro) and queue (audit pipeline) handlers
- [x] **FOUN-03**: API endpoints follow the exact MarketplaceClient contract from emdash-cms/emdash core
- [x] **FOUN-04**: D1 migrations managed via Wrangler with versioned SQL files
- [x] **FOUN-05**: Integration test validates API response shapes against MarketplaceClient types

### Discovery

- [x] **DISC-01**: Public API returns paginated plugin search results with query, category, capability, and sort parameters
- [x] **DISC-02**: Public API returns full plugin detail including author, capabilities, latest version, audit verdict, and risk score
- [x] **DISC-03**: Public API returns version history for a plugin with status, changelog, and audit results
- [x] **DISC-04**: Public API returns paginated theme search results with query, keyword, and sort parameters
- [x] **DISC-05**: Public API returns full theme detail with metadata, screenshots, and repository links
- [x] **DISC-06**: Browsing UI renders searchable plugin listing page with capability filters
- [x] **DISC-07**: Browsing UI renders plugin detail page with metadata, audit verdict, version history, and install button
- [x] **DISC-08**: Browsing UI renders theme listing and detail pages

### Authentication

- [x] **AUTH-01**: Publisher can authenticate via GitHub OAuth web flow from the browser
- [x] **AUTH-02**: Publisher can authenticate via GitHub OAuth device flow from the CLI
- [x] **AUTH-03**: Auth middleware protects write endpoints (publish, manage, retry-audit)
- [x] **AUTH-04**: Auth state stored in signed cookies (no server-side session writes)

### Publishing

- [x] **PUBL-01**: Authenticated publisher can register a new plugin with id, name, description, capabilities, keywords, license, and repository URL
- [x] **PUBL-02**: Authenticated publisher can upload a plugin version as a multipart tarball
- [x] **PUBL-03**: Uploaded bundle is validated before audit: manifest schema (Zod), bundle size limits (10MB compressed, 50MB decompressed, 200 files, 5MB/file)
- [x] **PUBL-04**: Valid bundle is stored in R2 and a pending version record is created in D1
- [x] **PUBL-05**: Bundle upload enqueues an audit job via Cloudflare Queues
- [x] **PUBL-06**: Publisher can retry a failed audit without re-uploading

### Audit

- [x] **AUDT-01**: Queue consumer runs Workers AI code audit using @cf/google/gemma-4-26b-a4b-it with structured JSON output
- [x] **AUDT-02**: Audit result updates version status: pass → published, warn → flagged, fail → rejected
- [x] **AUDT-03**: Audit findings stored in D1 with verdict, risk score, severity, title, description, category, and location
- [x] **AUDT-04**: Fail-closed model: if audit errors or times out, version is rejected (never silently published)

### Cost Protection

- [x] **COST-01**: Rate limiting: max 5 version uploads per author per day, tracked in D1
- [x] **COST-02**: Daily neuron budget cap (8K neurons/day) tracked in D1, hard-stops audit processing when exceeded
- [x] **COST-03**: Bundle validation runs before audit to reject invalid submissions without spending neurons
- [x] **COST-04**: General API rate limiting on search/download endpoints to stay within 100K Workers requests/day

### Downloads

- [x] **DOWN-01**: Public API serves plugin bundle tarballs from R2 for published versions only
- [x] **DOWN-02**: Install tracking accepts fire-and-forget POST with site hash and version (non-identifying)
- [x] **DOWN-03**: Install counts displayed on plugin detail and search results

### Publisher Dashboard

- [x] **DASH-01**: Authenticated publisher can view their plugins and submission status
- [x] **DASH-02**: Publisher can view audit results per version (verdict, risk score, individual findings)
- [x] **DASH-03**: Publisher can submit new versions from the dashboard
- [x] **DASH-04**: Publisher can manage plugin metadata (description, keywords, links)

### Theme Listings

- [x] **THEM-01**: Authenticated publisher can submit a theme listing with metadata (name, description, preview URL, repository URL, keywords, license)
- [x] **THEM-02**: Theme listings support thumbnail and screenshot uploads to R2
- [x] **THEM-03**: Theme browsing UI renders listing and detail pages

### GitHub App Integration

- [x] **GHAP-01**: Publisher can install the emdashcms GitHub App on a repository with scoped permissions (contents:read)
- [x] **GHAP-02**: Webhook receiver processes GitHub release events and triggers automatic tarball download, validation, and audit queue submission
- [x] **GHAP-03**: Private repo support via GitHub App installation tokens (no broad OAuth scopes)
- [x] **GHAP-04**: Publisher can configure release tag patterns, disconnect integration, and manage connected repos from dashboard

### Team & Collaborator Access

- [x] **TEAM-01**: Plugin owner can invite collaborators by GitHub username with role assignment (owner, maintainer, contributor)
- [x] **TEAM-02**: Role-based access control: owner (full control), maintainer (upload versions, edit metadata), contributor (view only)
- [x] **TEAM-03**: All write endpoints enforce role-based permissions — ownership transfer requires owner role
- [x] **TEAM-04**: Plugin owner can revoke collaborator access and transfer ownership to another collaborator

## v1.1 Requirements — Signals & Reach

### Publisher Notifications

- [ ] **NOTF-01**: Plugin owner and maintainers are notified when a version's audit completes (pass, warn, fail, error) via every enabled channel
- [ ] **NOTF-02**: Plugin and theme owners are notified when an abuse or security report is filed against their listing
- [ ] **NOTF-03**: Plugin and theme owners are notified when a moderator revokes a version or plugin, including any public admin note
- [ ] **NOTF-04**: Publishers can configure notification channels and outbound webhook URLs from a dashboard settings page, with changes persisted in D1
- [ ] **NOTF-05**: Notification delivery runs through a Cloudflare Queue with exponential backoff, at-most-once semantics, and dead-lettering after a bounded retry budget

### README Badges

- [ ] **BADG-01**: Public SVG badge endpoints under `/badges/v1/plugin/[id]/[metric].svg` serve correctly typed SVG with long-lived edge cache headers
- [ ] **BADG-02**: Badge metrics available: installs, latest version, trust tier, audit verdict, and EmDash compatibility
- [ ] **BADG-03**: Plugin detail and dashboard pages surface a copy-paste "Embed in README" panel with markdown and HTML snippets
- [ ] **BADG-04**: Badge edge cache is purged on revoke, new version publication, and trust tier changes
- [ ] **BADG-05**: Badge endpoints enforce per-IP rate limiting, are CSRF-exempt, and require no authentication

### Feeds and Weekly Digest

- [ ] **FEED-01**: `/feeds/plugins/new.xml` serves a valid Atom 1.0 feed of the 50 most recently published plugins
- [ ] **FEED-02**: `/feeds/plugins/updated.xml` serves a valid Atom 1.0 feed of plugins with recent version updates
- [ ] **FEED-03**: `/feeds/themes/new.xml` serves a valid Atom 1.0 feed of recently listed themes
- [ ] **FEED-04**: `/feeds/plugins/category/[category].xml` serves per-category Atom feeds; unknown categories return 404
- [ ] **FEED-05**: A weekly Cron worker generates ISO-week digest rows every Sunday 00:05 UTC and renders permanent `/digest/YYYY-Www` pages
- [ ] **FEED-06**: `/digest` lists all archived digests sorted newest first
- [ ] **FEED-07**: `robots.txt` and the BaseLayout advertise feed URLs for discoverability by readers and crawlers

### Transparency Report and Status Page

- [ ] **TRNS-01**: `/transparency` renders the latest weekly snapshot including versions submitted/published/flagged/rejected/revoked, reports filed and resolved by category, and anonymized Workers AI neuron spend
- [ ] **TRNS-02**: Weekly Cron computes and persists transparency snapshots in a `transparency_weeks` table, navigable as history on the transparency page
- [ ] **TRNS-03**: `/status` shows a last-7-day uptime strip for landing, plugins list, plugin detail, bundle download, and publishing API surfaces
- [ ] **TRNS-04**: A periodic (≤5-minute) Cron writes status samples into a `status_samples` table with enforced rolling 7-day retention
- [ ] **TRNS-05**: Transparency and status surfaces expose only aggregates — no individual plugin, author, or reporter is identifiable

### AI and Social Discoverability

- [ ] **AIDX-01**: `/llms.txt` at the site root serves a machine-readable marketplace index following the llms.txt convention with a summary per featured plugin
- [ ] **AIDX-02**: Plugin detail pages embed Schema.org `SoftwareApplication` JSON-LD matching visible content (name, author, version, applicationCategory, softwareRequirements, aggregateRating when reviews exist)
- [ ] **AIDX-03**: Theme detail pages embed Schema.org `CreativeWork` JSON-LD
- [ ] **AIDX-04**: Site root embeds Schema.org `Organization` JSON-LD via BaseLayout
- [ ] **AIDX-05**: `/og/plugin/[id].png` lazily generates a branded Open Graph image, stores it in R2 keyed by plugin id + latest version, and serves cached on subsequent requests
- [ ] **AIDX-06**: `/og/theme/[id].png` serves the equivalent generated image for themes
- [ ] **AIDX-07**: BaseLayout emits `og:image` (with width/height) on plugin and theme detail pages pointing at the generated image
- [ ] **AIDX-08**: `/sitemap.xml` enumerates plugin detail, theme detail, category, hook browse, and digest pages with accurate `<lastmod>`; `robots.txt` references the sitemap

### Deprecation and Unlist Self-Service

- [ ] **DEPR-01**: Authenticated plugin owner can mark their plugin as deprecated via the dashboard with a required reason and optional successor plugin id
- [ ] **DEPR-02**: Deprecated plugin detail pages render a prominent warning banner with the reason and successor link (when set) visible to anonymous visitors
- [ ] **DEPR-03**: Deprecated plugins are demoted in the default search sort but still appear in results and remain downloadable
- [ ] **DEPR-04**: Bundle download endpoints continue to serve deprecated versions so existing installs are unaffected
- [ ] **DEPR-05**: `POST /api/v1/plugins/:id/installs` response includes a `deprecationWarning` field when the plugin is deprecated
- [ ] **DEPR-06**: Successor selection rejects any successor that is itself deprecated and prevents cycles via a pre-write check
- [ ] **DEPR-07**: Owner can un-deprecate a plugin and can separately unlist a plugin (hidden from search and category pages but direct links and downloads continue to work)
- [ ] **DEPR-08**: Plugin cards and list rows display a visible "Deprecated" chip on deprecated plugins

## v2 Requirements

### Ratings & Reviews

- **REVW-01**: Users can rate plugins (1-5 stars)
- **REVW-02**: Users can write text reviews
- **REVW-03**: Plugin authors can respond to reviews

### Advanced Search

- **SRCH-01**: Full-text search across plugin name, description, and README
- **SRCH-02**: Search result ranking by relevance + install count

### Image Audit

- **IAUD-01**: Automated image audit for plugin icons and theme screenshots
- **IAUD-02**: Image audit results displayed alongside code audit

### Analytics

- **ANLT-01**: Publisher dashboard shows install trends over time
- **ANLT-02**: Geographic distribution of installs

## Out of Scope

| Feature | Reason |
|---------|--------|
| Paid/commercial plugin hosting | Legal complexity (tax, payments, disputes), no payment infrastructure on free tier |
| Federation/decentralized registry | Premature — no ecosystem to federate yet |
| On-chain anything | Unnecessary complexity |
| Custom CLI tool | EmDash already has `emdash plugin publish` — we just implement the API it calls |
| Plugin compatibility testing | EmDash is v1 — only one version to be compatible with |
| Plugin update notifications | Core CMS feature (polls marketplace), not marketplace's job |
| x402 payment protocol | Interesting but not needed now |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUN-01 | Phase 1 | Complete |
| FOUN-02 | Phase 1 | Complete |
| FOUN-03 | Phase 1 | Complete |
| FOUN-04 | Phase 1 | Complete |
| FOUN-05 | Phase 1 | Complete |
| DISC-01 | Phase 2 | Complete |
| DISC-02 | Phase 2 | Complete |
| DISC-03 | Phase 2 | Complete |
| DISC-04 | Phase 2 | Complete |
| DISC-05 | Phase 2 | Complete |
| DISC-06 | Phase 7 | Complete |
| DISC-07 | Phase 7 | Complete |
| DISC-08 | Phase 7 | Complete |
| AUTH-01 | Phase 3 | Complete |
| AUTH-02 | Phase 3 | Complete |
| AUTH-03 | Phase 3 | Complete |
| AUTH-04 | Phase 3 | Complete |
| PUBL-01 | Phase 4 | Complete |
| PUBL-02 | Phase 4 | Complete |
| PUBL-03 | Phase 4 | Complete |
| PUBL-04 | Phase 4 | Complete |
| PUBL-05 | Phase 4 | Complete |
| PUBL-06 | Phase 4 | Complete |
| AUDT-01 | Phase 5 | Complete |
| AUDT-02 | Phase 5 | Complete |
| AUDT-03 | Phase 5 | Complete |
| AUDT-04 | Phase 5 | Complete |
| COST-01 | Phase 4 | Complete |
| COST-02 | Phase 5 | Complete |
| COST-03 | Phase 4 | Complete |
| COST-04 | Phase 6 | Complete |
| DOWN-01 | Phase 6 | Complete |
| DOWN-02 | Phase 6 | Complete |
| DOWN-03 | Phase 6 | Complete |
| DASH-01 | Phase 8 | Complete |
| DASH-02 | Phase 8 | Complete |
| DASH-03 | Phase 8 | Complete |
| DASH-04 | Phase 8 | Complete |
| THEM-01 | Phase 9 | Complete |
| THEM-02 | Phase 9 | Complete |
| THEM-03 | Phase 9 | Complete |
| GHAP-01 | Phase 10 | Complete |
| GHAP-02 | Phase 10 | Complete |
| GHAP-03 | Phase 10 | Complete |
| GHAP-04 | Phase 10 | Complete |
| TEAM-01 | Phase 11 | Complete |
| TEAM-02 | Phase 11 | Complete |
| TEAM-03 | Phase 11 | Complete |
| TEAM-04 | Phase 11 | Complete |
| NOTF-01 | Phase 12 | Planned |
| NOTF-02 | Phase 12 | Planned |
| NOTF-03 | Phase 12 | Planned |
| NOTF-04 | Phase 12 | Planned |
| NOTF-05 | Phase 12 | Planned |
| BADG-01 | Phase 13 | Planned |
| BADG-02 | Phase 13 | Planned |
| BADG-03 | Phase 13 | Planned |
| BADG-04 | Phase 13 | Planned |
| BADG-05 | Phase 13 | Planned |
| FEED-01 | Phase 14 | Planned |
| FEED-02 | Phase 14 | Planned |
| FEED-03 | Phase 14 | Planned |
| FEED-04 | Phase 14 | Planned |
| FEED-05 | Phase 14 | Planned |
| FEED-06 | Phase 14 | Planned |
| FEED-07 | Phase 14 | Planned |
| TRNS-01 | Phase 15 | Planned |
| TRNS-02 | Phase 15 | Planned |
| TRNS-03 | Phase 15 | Planned |
| TRNS-04 | Phase 15 | Planned |
| TRNS-05 | Phase 15 | Planned |
| AIDX-01 | Phase 16 | Planned |
| AIDX-02 | Phase 16 | Planned |
| AIDX-03 | Phase 16 | Planned |
| AIDX-04 | Phase 16 | Planned |
| AIDX-05 | Phase 16 | Planned |
| AIDX-06 | Phase 16 | Planned |
| AIDX-07 | Phase 16 | Planned |
| AIDX-08 | Phase 16 | Planned |
| DEPR-01 | Phase 17 | Planned |
| DEPR-02 | Phase 17 | Planned |
| DEPR-03 | Phase 17 | Planned |
| DEPR-04 | Phase 17 | Planned |
| DEPR-05 | Phase 17 | Planned |
| DEPR-06 | Phase 17 | Planned |
| DEPR-07 | Phase 17 | Planned |
| DEPR-08 | Phase 17 | Planned |

**Coverage:**
- v1 requirements: 49 total (41 original + 8 new from Phases 10-11), all mapped
- v1.1 requirements: 36 total across Phases 12-17, all mapped
- Unmapped: 0

---
*Requirements defined: 2026-04-04*
*Last updated: 2026-04-06 — added v1.1 "Signals & Reach" milestone requirements*
