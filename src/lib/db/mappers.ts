import type {
  MarketplaceAuthor,
  MarketplaceAuditSummary,
  MarketplaceAuditDetail,
  MarketplaceAuditFinding,
  MarketplacePluginSummary,
  MarketplacePluginDetail,
  MarketplaceVersionSummary,
  MarketplaceThemeSummary,
  MarketplaceThemeDetail,
} from "../../types/marketplace";

type Row = Record<string, unknown>;

export function mapAuthor(row: Row): MarketplaceAuthor {
  return {
    name: row.github_username as string,
    verified: Boolean(row.verified),
    avatarUrl: (row.avatar_url as string) ?? null,
  };
}

export function mapAuditSummary(row: Row): MarketplaceAuditSummary | null {
  if (!row.verdict) return null;
  return {
    verdict: row.verdict as "pass" | "warn" | "fail",
    riskScore: row.risk_score as number,
  };
}

export function mapAuditDetail(row: Row): MarketplaceAuditDetail | null {
  if (!row.verdict) return null;
  return {
    verdict: row.verdict as "pass" | "warn" | "fail",
    riskScore: row.risk_score as number,
    findings: JSON.parse((row.findings as string) || "[]"),
  };
}

export function mapPluginSummary(row: Row): MarketplacePluginSummary {
  const latestVersion = row.latest_version
    ? {
        version: row.latest_version as string,
        // searchPlugins only surfaces `published`/`flagged` — fall back to
        // `published` defensively if the query didn't include the column.
        status:
          ((row.latest_version_status as string) === "flagged"
            ? "flagged"
            : "published") as "published" | "flagged",
        audit: row.latest_audit_verdict
          ? {
              verdict: row.latest_audit_verdict as "pass" | "warn" | "fail",
              riskScore: (row.latest_audit_risk_score as number) ?? 0,
            }
          : null,
      }
    : null;

  const iconKey = row.icon_key as string | null;
  return {
    id: row.id as string,
    name: row.name as string,
    shortDescription: (row.short_description as string) ?? null,
    description: (row.description as string) ?? null,
    author: mapAuthor(row),
    capabilities: JSON.parse((row.capabilities as string) || "[]"),
    keywords: JSON.parse((row.keywords as string) || "[]"),
    installCount: (row.installs_count as number) ?? 0,
    hasIcon: iconKey !== null,
    iconUrl: iconKey ? `/api/v1/images/${iconKey}` : null,
    latestVersion,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapPluginDetail(
  pluginRow: Row,
  versionRow: Row | null,
): MarketplacePluginDetail {
  const base = mapPluginSummary(pluginRow);

  let latestVersion: MarketplacePluginDetail["latestVersion"] = null;
  if (versionRow) {
    const manifest = JSON.parse((versionRow.manifest as string) || "{}");
    latestVersion = {
      version: versionRow.version as string,
      bundleSize: (versionRow.compressed_size as number) ?? 0,
      checksum: (versionRow.checksum as string) ?? "",
      changelog: (versionRow.changelog as string) ?? null,
      readme: (versionRow.readme as string) ?? null,
      screenshots: [], // No screenshot storage yet
      capabilities: Array.isArray(manifest.capabilities)
        ? manifest.capabilities
        : [],
      // getPluginDetail only returns versions where status IN
      // ('published', 'flagged'), so narrow to that union.
      status: versionRow.status as "published" | "flagged",
      audit: mapAuditDetail(versionRow),
      imageAudit: null, // No image audit system in v1
    };
  }

  return {
    ...base,
    category: (pluginRow.category as string) ?? null,
    repositoryUrl: (pluginRow.repository_url as string) ?? null,
    homepageUrl: (pluginRow.homepage_url as string) ?? null,
    license: (pluginRow.license as string) ?? null,
    latestVersion,
  };
}

export function mapVersionSummary(row: Row): MarketplaceVersionSummary {
  const manifest = JSON.parse((row.manifest as string) || "{}");
  return {
    version: row.version as string,
    minEmDashVersion: (row.min_emdash_version as string) ?? null,
    bundleSize: (row.compressed_size as number) ?? 0,
    checksum: (row.checksum as string) ?? "",
    changelog: (row.changelog as string) ?? null,
    capabilities: Array.isArray(manifest.capabilities)
      ? manifest.capabilities
      : [],
    status: row.status as "pending" | "published" | "flagged" | "rejected",
    auditVerdict: (row.verdict as "pass" | "warn" | "fail") ?? null,
    imageAuditVerdict: null, // No image audit system in v1
    publishedAt: ((row.published_at ?? row.created_at) as string),
  };
}

export function mapThemeSummary(row: Row): MarketplaceThemeSummary {
  const thumbnailKey = row.thumbnail_key as string | null;
  return {
    id: row.id as string,
    name: row.name as string,
    shortDescription: (row.short_description as string) ?? null,
    description: (row.description as string) ?? null,
    author: mapAuthor(row),
    keywords: JSON.parse((row.keywords as string) || "[]"),
    previewUrl: (row.preview_url as string) ?? null,
    demoUrl: (row.demo_url as string) ?? null,
    hasThumbnail: thumbnailKey !== null,
    thumbnailUrl: thumbnailKey ? `/api/v1/images/${thumbnailKey}` : null,
  };
}

export function mapThemeDetail(row: Row): MarketplaceThemeDetail {
  const screenshotKeys: string[] = JSON.parse(
    (row.screenshot_keys as string) || "[]",
  );
  return {
    ...mapThemeSummary(row),
    category: (row.category as string) ?? null,
    repositoryUrl: (row.repository_url as string) ?? null,
    homepageUrl: (row.homepage_url as string) ?? null,
    license: (row.license as string) ?? null,
    screenshotCount: screenshotKeys.length,
    screenshotUrls: screenshotKeys.map((key) => `/api/v1/images/${key}`),
  };
}

// --- Dashboard mappers ---

export function mapDashboardPlugin(row: Row): {
  id: string;
  name: string;
  latestVersion: string | null;
  latestStatus: string | null;
  installCount: number;
  updatedAt: string;
} {
  return {
    id: row.id as string,
    name: row.name as string,
    latestVersion: (row.latest_version as string) ?? null,
    latestStatus: (row.latest_status as string) ?? null,
    installCount: (row.installs_count as number) ?? 0,
    updatedAt: row.updated_at as string,
  };
}

type VersionStatus =
  | "pending"
  | "published"
  | "flagged"
  | "rejected"
  | "revoked";
type TrustTier =
  | "unreviewed"
  | "scanned"
  | "scanned-caution"
  | "ai-reviewed"
  | "ai-reviewed-caution"
  | "rejected";

/**
 * Derive the visible trust tier from `status` + the most recent audit's
 * `model` field. No D1 column — this is computed at read time to keep
 * the schema simple. Rules:
 *
 *   - `status='pending'`                             → 'unreviewed'
 *   - `status='rejected' | 'revoked'`                → 'rejected'
 *   - `status='published'` + AI model                → 'ai-reviewed'
 *   - `status='flagged'`   + AI model                → 'ai-reviewed-caution'
 *   - `status='published'` + static-only model       → 'scanned'
 *   - `status='flagged'`   + static-only model       → 'scanned-caution'
 *   - Everything else (admin-action, unknown model)  → derived from status
 *     alone to avoid showing a stale AI tier.
 */
export function deriveTrustTier(
  status: VersionStatus,
  model: string | null,
): TrustTier {
  if (status === "pending") return "unreviewed";
  if (status === "rejected" || status === "revoked") return "rejected";

  const isAiModel = typeof model === "string" && model.startsWith("@cf/");
  const isStatic = model === "static-only";

  if (status === "published") {
    if (isAiModel) return "ai-reviewed";
    if (isStatic) return "scanned";
    // admin-action published (manual approve) — treat as scanned so the
    // plugin still gets a positive tier rather than the neutral Unreviewed.
    return "scanned";
  }

  if (status === "flagged") {
    if (isAiModel) return "ai-reviewed-caution";
    if (isStatic) return "scanned-caution";
    return "scanned-caution";
  }

  return "unreviewed";
}

export function mapVersionDetail(
  row: Row,
  adminRejectionReason: string | null = null,
): {
  version: string;
  status: VersionStatus;
  retryCount: number;
  createdAt: string;
  verdict: "pass" | "warn" | "fail" | null;
  riskScore: number | null;
  findings: MarketplaceAuditFinding[];
  latestAuditModel: string | null;
  trustTier: TrustTier;
  adminRejectionReason: string | null;
} {
  const status = row.status as VersionStatus;
  const latestAuditModel = (row.latest_audit_model as string) ?? null;
  return {
    version: row.version as string,
    status: status as VersionStatus,
    retryCount: (row.retry_count as number) ?? 0,
    createdAt: row.created_at as string,
    verdict: (row.verdict as "pass" | "warn" | "fail") ?? null,
    riskScore: (row.risk_score as number) ?? null,
    findings: JSON.parse((row.findings as string) || "[]"),
    latestAuditModel,
    trustTier: deriveTrustTier(status as VersionStatus, latestAuditModel),
    adminRejectionReason,
  };
}
