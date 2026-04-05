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
  status: "pending" | "published" | "flagged" | "rejected";
  auditVerdict: "pass" | "warn" | "fail" | null;
  imageAuditVerdict: string | null;
  publishedAt: string;
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
  hasIcon: boolean;
  iconUrl: string | null;
  latestVersion: {
    version: string;
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
  latestVersion: {
    version: string;
    bundleSize: number;
    checksum: string;
    changelog: string | null;
    readme: string | null;
    screenshots: string[];
    capabilities: string[];
    status: "pending" | "published" | "flagged" | "rejected";
    audit: MarketplaceAuditDetail | null;
    imageAudit: unknown | null;
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

export interface AuditJob {
  pluginId: string;
  version: string;
  authorId: string;
  bundleKey: string;
}
