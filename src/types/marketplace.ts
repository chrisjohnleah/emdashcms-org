// MarketplaceClient API contract types
// Matches the interface from emdash-cms/emdash packages/core/src/plugins/marketplace.ts

// --- Author ---

export interface MarketplaceAuthor {
  name: string;
  verified: boolean;
  avatarUrl: string | null;
}

// --- Audit ---

export interface MarketplaceAuditSummary {
  verdict: "pass" | "warn" | "fail";
  riskScore: number;
}

export interface MarketplaceAuditFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  category: string;
  location: string | null;
}

export interface MarketplaceAuditDetail extends MarketplaceAuditSummary {
  findings: MarketplaceAuditFinding[];
}

// --- Version ---

export interface MarketplaceVersionSummary {
  version: string;
  minEmDashVersion: string | null;
  bundleSize: number;
  checksum: string;
  changelog: string | null;
  capabilities: string[];
  status: "pending" | "published" | "flagged" | "rejected" | "revoked";
  auditVerdict: "pass" | "warn" | "fail" | null;
  imageAuditVerdict: string | null;
  publishedAt: string;
  /**
   * Per-version raw download count. Lets the dashboard chart "v0.2.4
   * vs v0.2.3" trends instead of just showing one cumulative number
   * for the whole plugin. Incremented on every successful bundle GET
   * alongside the plugin-level counter.
   */
  downloadCount: number;
  /**
   * Scanner/AI findings for this version, available for any rejected or
   * revoked version. Populated so the public plugin detail page can
   * expand an accordion showing why a version was refused — the scanner
   * ruleset is public at /docs/security, and individual findings are
   * part of that transparency.
   */
  findings: MarketplaceAuditFinding[];
  /**
   * Admin rejection/revocation note for this version, when one exists
   * AND the admin marked it as public via the "Post note publicly"
   * checkbox. Null otherwise — private notes stay in the D1 audit
   * record and are not exposed here.
   */
  publicAdminNote: string | null;
}

export interface MarketplaceVersionDetail extends MarketplaceVersionSummary {
  readme: string | null;
  screenshots: string[];
  audit: MarketplaceAuditDetail | null;
  imageAudit: unknown | null;
}

// --- Plugin ---

export interface MarketplacePluginSummary {
  id: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  author: MarketplaceAuthor;
  capabilities: string[];
  keywords: string[];
  installCount: number;
  /**
   * Raw bundle download count — incremented on every successful GET to
   * the version bundle endpoint, with no site-level dedup. Distinct
   * from `installCount`, which counts unique sites that called the CLI
   * install-tracking endpoint after a successful install. Use
   * `downloadCount` for "popularity" surfaces and `installCount` for
   * "real installs" surfaces.
   */
  downloadCount: number;
  hasIcon: boolean;
  iconUrl: string | null;
  latestVersion: {
    version: string;
    /**
     * Latest version status. Published plugins can be in `published` or
     * `flagged` state — the distinction lets the UI show a Caution trust
     * tier for flagged versions. Additive field; upstream clients that
     * only read `version` + `audit` remain compatible.
     */
    status: "published" | "flagged";
    audit: MarketplaceAuditSummary | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplacePluginDetail extends MarketplacePluginSummary {
  category: string | null;
  repositoryUrl: string | null;
  homepageUrl: string | null;
  license: string | null;
  /**
   * Plugin-level status. `revoked` plugins still return from
   * getPluginDetail (so the tombstone page can render) but are hidden
   * from browse results. Internal clients should only surface revoked
   * plugins with a clear "revoked" banner.
   */
  pluginStatus: "active" | "revoked";
  latestVersion: {
    version: string;
    bundleSize: number;
    checksum: string;
    changelog: string | null;
    readme: string | null;
    screenshots: string[];
    capabilities: string[];
    // getPluginDetail filters to published/flagged, matching the summary.
    status: "published" | "flagged";
    audit: MarketplaceAuditDetail | null;
    imageAudit: unknown | null;
    /** Provenance — GitHub release URL when webhook-sourced. */
    releaseUrl: string | null;
    /** Provenance — commit SHA when available. Usually null. */
    commitSha: string | null;
  } | null;
}

// --- Theme ---

export interface MarketplaceThemeSummary {
  id: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  author: MarketplaceAuthor;
  keywords: string[];
  previewUrl: string | null;
  demoUrl: string | null;
  hasThumbnail: boolean;
  thumbnailUrl: string | null;
  /**
   * Outbound-click count — incremented when a user clicks through to
   * the npm package, repository, or demo from the theme detail page.
   * Themes are metadata-only (no bundle in our R2), so this is the
   * only "interest" signal we can capture. Use it as the popularity
   * surface for theme listings.
   */
  downloadCount: number;
}

export interface MarketplaceThemeDetail extends MarketplaceThemeSummary {
  category: string | null;
  repositoryUrl: string | null;
  homepageUrl: string | null;
  license: string | null;
  screenshotCount: number;
  screenshotUrls: string[];
}

// --- Search ---

export interface MarketplaceSearchResult<T> {
  items: T[];
  nextCursor: string | null;
}

// --- Bundle ---

export interface PluginManifest {
  id: string;
  version: string;
  capabilities: string[];
  allowedHosts: string[];
  storage: Record<string, unknown> | null;
  hooks: string[];
  routes: string[];
  admin: Record<string, unknown> | null;
}

export interface PluginBundle {
  manifest: PluginManifest;
  backendCode: string;
  adminCode: string | null;
  checksum: string;
}

// --- Queue Job ---

/**
 * Friendly key identifying which AI model to run for an audit. The full
 * Workers AI model id (e.g. "@cf/meta/llama-3.2-3b-instruct") is resolved
 * from the AUDIT_MODELS registry in src/lib/audit/prompt.ts. Keys live in
 * the type layer so AuditJob can carry them without importing audit code.
 */
export type AuditModelKey =
  | "mistral-small-3.1-24b"
  | "qwen2.5-coder-32b"
  | "glm-4.7-flash"
  | "gemma-4-26b-a4b";

export interface AuditJob {
  pluginId: string;
  version: string;
  authorId: string;
  bundleKey: string;
  /**
   * Optional per-job override of the global AUDIT_MODE. Set by admin
   * actions like "Run AI audit" or "Run static scan" so the admin can
   * force a specific behaviour on a single version regardless of the
   * Worker's configured mode.
   */
  auditModeOverride?: "manual" | "auto" | "off" | "static-first";
  /**
   * Optional per-job override of which AI model runs for this audit.
   * Only meaningful when the resolved mode is "auto". Falls back to
   * the default model in AUDIT_MODELS when omitted or unrecognised.
   */
  modelOverride?: AuditModelKey;
}

// --- Notification Pipeline (Phase 12 — NOTF-01/02/03/04/05) ---

/**
 * Every notification event type recognised by the pipeline. The first
 * seven are user-configurable per-event preferences (D-08); `test_send`
 * and `digest` are internal types used by the "Send test email" button
 * and the daily digest cron respectively.
 */
export type NotificationEventType =
  | "audit_fail"
  | "audit_error"
  | "audit_warn"
  | "audit_pass"
  | "revoke_version"
  | "revoke_plugin"
  | "report_filed"
  | "test_send"
  | "digest";

/**
 * Entity the notification refers to. `none` is reserved for test_send
 * and future account-level notifications that don't target a plugin
 * or theme.
 */
export type NotificationEntityType = "plugin" | "theme" | "none";

/**
 * How the notification should be delivered. `immediate` means enqueue a
 * NOTIF_QUEUE job to send right away; `daily_digest` means the delivery
 * row is written but the send is deferred to the daily digest cron.
 */
export type NotificationDeliveryMode = "immediate" | "daily_digest";

/**
 * Payload for NOTIF_QUEUE messages. Well under the 128KB queue message
 * limit — payloads typically under 1KB. Rendering templates, recipient
 * resolution, and preference checks happen at emit time, not in the
 * consumer, so the consumer only needs this narrow shape.
 */
export interface NotificationJob {
  eventType: NotificationEventType;
  /** Stable UUID from the source record (audit id / report id / synthetic for test). */
  eventId: string;
  entityType: NotificationEntityType;
  /** Plugin or theme id; null for test_send and account-level events. */
  entityId: string | null;
  /** Resolved recipient (owner/maintainer) — fan-out happens before enqueue. */
  recipientAuthorId: string;
  deliveryMode: NotificationDeliveryMode;
  /** Event-specific data for template rendering. Shape varies by eventType. */
  payload: Record<string, unknown>;
}
