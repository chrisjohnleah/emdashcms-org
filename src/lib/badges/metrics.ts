/**
 * Badge metric fetcher + per-metric content builders.
 *
 * The fetcher performs exactly ONE D1 prepared statement per call — a
 * correlated-subquery SELECT that collects `installs_count`, the latest
 * published/flagged version, its `min_emdash_version`, and the latest
 * audit verdict + model in a single round-trip. This honours success
 * criterion 4 ("at most one D1 read per cache miss").
 *
 * Trust-tier derivation is delegated to `deriveTrustTier()` in
 * `src/lib/db/mappers.ts` — DO NOT re-implement the rules here. The
 * tier-to-label lookup mirrors `src/components/TrustTierBadge.astro`
 * VERBATIM including the em-dash in "Scanned — Caution" /
 * "AI-reviewed — Caution" (D-20).
 */

import { deriveTrustTier } from "../db/mappers";
import { BADGE_COLORS, type BadgeColor } from "./render";

/**
 * Local mirror of the `TrustTier` union declared privately in
 * `src/lib/db/mappers.ts`. Kept in sync with the deriveTrustTier
 * return type; `mappers.ts` does not export the type, so we redeclare
 * it here to type the tier-to-visual lookup without forcing a churny
 * export. If mappers.ts ever adds a new tier, this union must be
 * updated — the D-20 verbatim-label test suite will catch a drift.
 */
type TrustTier =
  | "unreviewed"
  | "scanned"
  | "scanned-caution"
  | "ai-reviewed"
  | "ai-reviewed-caution"
  | "rejected";

/**
 * Badge metric names: the five locked by D-01 (installs / version /
 * trust-tier / audit-verdict / compat) plus the Phase 22 `lifecycle`
 * entry appended at the end so existing badge ordering in the embed
 * panel and snippet blocks is preserved.
 *
 * The dynamic `/badges/v1/plugin/[id]/[metric].svg` route gates on this
 * tuple as its allow-list (see `handleBadgeRequest`), so appending a
 * new entry lights up the corresponding URL automatically — no new
 * route file is required for `lifecycle.svg`.
 */
export const BADGE_METRICS = [
  "installs",
  "version",
  "trust-tier",
  "audit-verdict",
  "compat",
  "lifecycle",
] as const;

export type BadgeMetric = (typeof BADGE_METRICS)[number];

/**
 * Narrow shape of everything the metric builders need. Everything is
 * nullable when the plugin does not exist, has no published version,
 * or has no audit record — D-04 unknown/muted fallback applies at the
 * builder layer. The Phase 22 `deprecatedAt` / `unlistedAt` fields are
 * inputs to the lifecycle builder; both null on an active plugin.
 */
export interface BadgeData {
  pluginExists: boolean;
  pluginStatus: "active" | "revoked" | null;
  installsCount: number;
  latestVersion: string | null;
  latestVersionStatus: "published" | "flagged" | null;
  latestAuditVerdict: "pass" | "warn" | "fail" | null;
  latestAuditModel: string | null;
  minEmDashVersion: string | null;
  // Phase 22 (D-04): lifecycle state inputs. Both null = active plugin.
  // Read alongside the existing top-level columns in the same SELECT so
  // the one-D1-read budget (D-06) is preserved — no new subqueries.
  deprecatedAt: string | null;
  unlistedAt: string | null;
}

/**
 * Standard `k` / `M` abbreviation used by Shields.io. Below 1k we keep
 * the literal count for publisher delight ("523 installs").
 */
export function formatCount(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  if (n < 1_000_000) {
    return Math.round(n / 1000) + "k";
  }
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/**
 * Tier-to-visual lookup mirroring `TrustTierBadge.astro` verbatim. The
 * em-dash in "Scanned — Caution" and "AI-reviewed — Caution" is
 * load-bearing — do not substitute a plain hyphen. D-20 mandate.
 */
const TRUST_TIER_VISUALS: Record<TrustTier, { label: string; color: BadgeColor }> = {
  unreviewed: { label: "Unreviewed", color: BADGE_COLORS.muted },
  scanned: { label: "Scanned", color: BADGE_COLORS.success },
  "scanned-caution": { label: "Scanned — Caution", color: BADGE_COLORS.warn },
  "ai-reviewed": { label: "AI-reviewed", color: BADGE_COLORS.success },
  "ai-reviewed-caution": {
    label: "AI-reviewed — Caution",
    color: BADGE_COLORS.warn,
  },
  rejected: { label: "Rejected", color: BADGE_COLORS.danger },
};

type BadgeContent = { label: string; value: string; color: BadgeColor };

const UNKNOWN_MUTED = (label: string): BadgeContent => ({
  label,
  value: "unknown",
  color: BADGE_COLORS.muted,
});

/**
 * Fetch all badge-relevant state for a plugin in one D1 prepared
 * statement. Returns `pluginExists: false` (and all-null / zero fields)
 * for unknown plugin ids so the caller can render the D-04 "unknown"
 * badge rather than 404ing.
 */
export async function getBadgeData(
  db: D1Database,
  pluginId: string,
): Promise<BadgeData> {
  // Single D1 prepared statement — honours the "one D1 read per cache
  // miss" budget (success criterion 4). Correlated subqueries run
  // inside the same read and do not count separately.
  const stmt = db.prepare(
      `SELECT
         p.installs_count,
         p.status AS plugin_status,
         p.deprecated_at,
         p.unlisted_at,
         (SELECT pv.version FROM plugin_versions pv
          WHERE pv.plugin_id = p.id AND pv.status IN ('published','flagged')
          ORDER BY pv.created_at DESC LIMIT 1) AS latest_version,
         (SELECT pv.status FROM plugin_versions pv
          WHERE pv.plugin_id = p.id AND pv.status IN ('published','flagged')
          ORDER BY pv.created_at DESC LIMIT 1) AS latest_version_status,
         (SELECT pv.min_emdash_version FROM plugin_versions pv
          WHERE pv.plugin_id = p.id AND pv.status IN ('published','flagged')
          ORDER BY pv.created_at DESC LIMIT 1) AS min_emdash_version,
         (SELECT pa.verdict FROM plugin_versions pv
          LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
            AND pa.created_at = (SELECT MAX(pa2.created_at) FROM plugin_audits pa2
                                 WHERE pa2.plugin_version_id = pv.id)
          WHERE pv.plugin_id = p.id AND pv.status IN ('published','flagged')
          ORDER BY pv.created_at DESC LIMIT 1) AS latest_audit_verdict,
         (SELECT pa.model FROM plugin_versions pv
          LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
            AND pa.created_at = (SELECT MAX(pa2.created_at) FROM plugin_audits pa2
                                 WHERE pa2.plugin_version_id = pv.id)
          WHERE pv.plugin_id = p.id AND pv.status IN ('published','flagged')
          ORDER BY pv.created_at DESC LIMIT 1) AS latest_audit_model
       FROM plugins p
       WHERE p.id = ?`,
  );
  const row = await stmt.bind(pluginId).first<{
    installs_count: number | null;
    plugin_status: string | null;
    deprecated_at: string | null;
    unlisted_at: string | null;
    latest_version: string | null;
    latest_version_status: string | null;
    min_emdash_version: string | null;
    latest_audit_verdict: string | null;
    latest_audit_model: string | null;
  }>();

  if (!row) {
    return {
      pluginExists: false,
      pluginStatus: null,
      installsCount: 0,
      latestVersion: null,
      latestVersionStatus: null,
      latestAuditVerdict: null,
      latestAuditModel: null,
      minEmDashVersion: null,
      deprecatedAt: null,
      unlistedAt: null,
    };
  }

  const verdictRaw = row.latest_audit_verdict;
  const verdict =
    verdictRaw === "pass" || verdictRaw === "warn" || verdictRaw === "fail"
      ? verdictRaw
      : null;

  const versionStatusRaw = row.latest_version_status;
  const versionStatus =
    versionStatusRaw === "published" || versionStatusRaw === "flagged"
      ? versionStatusRaw
      : null;

  const pluginStatus =
    row.plugin_status === "revoked"
      ? "revoked"
      : row.plugin_status === "active"
        ? "active"
        : ((row.plugin_status ?? "active") as "active");

  return {
    pluginExists: true,
    pluginStatus,
    installsCount: row.installs_count ?? 0,
    latestVersion: row.latest_version,
    latestVersionStatus: versionStatus,
    latestAuditVerdict: verdict,
    latestAuditModel: row.latest_audit_model,
    minEmDashVersion: row.min_emdash_version,
    deprecatedAt: row.deprecated_at,
    unlistedAt: row.unlisted_at,
  };
}

/**
 * Pure per-metric content builder. Given the fetched BadgeData, return
 * the label / value / color the SVG template should render. Unknown
 * plugin ids and per-metric data gaps render the muted "unknown"
 * badge per D-04.
 */
export function buildBadgeContent(
  metric: BadgeMetric,
  data: BadgeData,
): BadgeContent {
  switch (metric) {
    case "installs": {
      if (!data.pluginExists) return UNKNOWN_MUTED("installs");
      return {
        label: "installs",
        value: formatCount(data.installsCount),
        color: BADGE_COLORS.success,
      };
    }

    case "version": {
      if (!data.pluginExists || !data.latestVersion) {
        return UNKNOWN_MUTED("version");
      }
      return {
        label: "version",
        value: `v${data.latestVersion}`,
        color: BADGE_COLORS.success,
      };
    }

    case "trust-tier": {
      if (!data.pluginExists || !data.latestVersionStatus) {
        return UNKNOWN_MUTED("trust");
      }
      const tier = deriveTrustTier(
        data.latestVersionStatus,
        data.latestAuditModel,
      );
      const visual = TRUST_TIER_VISUALS[tier];
      return {
        label: "trust",
        value: visual.label,
        color: visual.color,
      };
    }

    case "audit-verdict": {
      if (!data.pluginExists) return UNKNOWN_MUTED("audit");
      switch (data.latestAuditVerdict) {
        case "pass":
          return { label: "audit", value: "passing", color: BADGE_COLORS.success };
        case "warn":
          return { label: "audit", value: "warnings", color: BADGE_COLORS.warn };
        case "fail":
          return { label: "audit", value: "failing", color: BADGE_COLORS.danger };
        default:
          return { label: "audit", value: "unreviewed", color: BADGE_COLORS.muted };
      }
    }

    case "compat": {
      if (!data.pluginExists) return UNKNOWN_MUTED("emdash");
      if (!data.minEmDashVersion) {
        return { label: "emdash", value: "any", color: BADGE_COLORS.muted };
      }
      return {
        label: "emdash",
        value: `≥ ${data.minEmDashVersion}`,
        color: BADGE_COLORS.success,
      };
    }

    case "lifecycle": {
      // D-04 four-state lifecycle mapping with an unknown fallback.
      // Precedence is load-bearing: revoked overrides every other state
      // among existing plugins; deprecated overrides unlisted; unlisted
      // only when not deprecated; otherwise active.
      if (!data.pluginExists) return UNKNOWN_MUTED("lifecycle");
      if (data.pluginStatus === "revoked") {
        return { label: "lifecycle", value: "revoked", color: BADGE_COLORS.danger };
      }
      if (data.deprecatedAt !== null) {
        return { label: "lifecycle", value: "deprecated", color: BADGE_COLORS.warn };
      }
      if (data.unlistedAt !== null) {
        return { label: "lifecycle", value: "unlisted", color: BADGE_COLORS.muted };
      }
      return { label: "lifecycle", value: "active", color: BADGE_COLORS.success };
    }
  }
}
