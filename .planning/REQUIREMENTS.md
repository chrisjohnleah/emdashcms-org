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
- [ ] **TEAM-03**: All write endpoints enforce role-based permissions — ownership transfer requires owner role
- [x] **TEAM-04**: Plugin owner can revoke collaborator access and transfer ownership to another collaborator

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

### Notifications

- **NOTF-01**: Email/GitHub notification when audit completes
- **NOTF-02**: Webhook support for CI/CD integration

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
| TEAM-03 | Phase 11 | Pending |
| TEAM-04 | Phase 11 | Complete |

**Coverage:**
- v1 requirements: 49 total (41 original + 8 new from Phases 10-11)
- Mapped to phases: 49
- Unmapped: 0

---
*Requirements defined: 2026-04-04*
*Last updated: 2026-04-04 after roadmap creation*
