import type {
  MarketplaceSearchResult,
  MarketplacePluginSummary,
  MarketplacePluginDetail,
  MarketplaceVersionSummary,
  MarketplaceAuditFinding,
  MarketplaceThemeSummary,
  MarketplaceThemeDetail,
} from "../../types/marketplace";
import {
  mapPluginSummary,
  mapPluginDetail,
  mapVersionSummary,
  mapDashboardPlugin,
  mapVersionDetail,
  mapThemeSummary,
  mapThemeDetail,
} from "./mappers";
import { encodeCursor, decodeCursor } from "../api/pagination";

// --- Plugin queries ---

interface SearchPluginsOpts {
  query: string;
  category: string | null;
  capability: string | null;
  sort: string;
  cursor: string | null;
  limit: number;
}

const PLUGIN_SORT_MAP: Record<string, { column: string; dir: "DESC" | "ASC" }> =
  {
    installs: { column: "p.installs_count", dir: "DESC" },
    updated: { column: "p.updated_at", dir: "DESC" },
    created: { column: "p.created_at", dir: "DESC" },
    name: { column: "p.name", dir: "ASC" },
  };

export async function searchPlugins(
  db: D1Database,
  opts: SearchPluginsOpts,
): Promise<MarketplaceSearchResult<MarketplacePluginSummary>> {
  const sortDef = PLUGIN_SORT_MAP[opts.sort] ?? PLUGIN_SORT_MAP.installs;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.query) {
    conditions.push(
      "(p.name LIKE ? COLLATE NOCASE OR p.short_description LIKE ? COLLATE NOCASE OR p.description LIKE ? COLLATE NOCASE)",
    );
    const pattern = `%${opts.query}%`;
    params.push(pattern, pattern, pattern);
  }

  if (opts.category) {
    conditions.push("p.category = ?");
    params.push(opts.category);
  }

  if (opts.capability) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(p.capabilities) WHERE value = ?)",
    );
    params.push(opts.capability);
  }

  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const op = sortDef.dir === "DESC" ? "<" : ">";
      conditions.push(`(${sortDef.column}, p.id) ${op} (?, ?)`);
      params.push(decoded.s, decoded.id);
    }
  }

  // Only show active plugins with at least one published version
  conditions.push("COALESCE(p.status, 'active') = 'active'");
  conditions.push(
    "EXISTS (SELECT 1 FROM plugin_versions pv0 WHERE pv0.plugin_id = p.id AND pv0.status IN ('published', 'flagged'))",
  );

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const sql = `
    SELECT
      p.*,
      a.github_username,
      a.avatar_url,
      a.verified,
      (
        SELECT pv.version
        FROM plugin_versions pv
        WHERE pv.plugin_id = p.id AND pv.status IN ('published', 'flagged')
        ORDER BY pv.created_at DESC LIMIT 1
      ) AS latest_version,
      (
        SELECT pa.verdict
        FROM plugin_versions pv2
        LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv2.id
        WHERE pv2.plugin_id = p.id AND pv2.status IN ('published', 'flagged')
        ORDER BY pv2.created_at DESC LIMIT 1
      ) AS latest_audit_verdict,
      (
        SELECT pa.risk_score
        FROM plugin_versions pv3
        LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv3.id
        WHERE pv3.plugin_id = p.id AND pv3.status IN ('published', 'flagged')
        ORDER BY pv3.created_at DESC LIMIT 1
      ) AS latest_audit_risk_score
    FROM plugins p
    JOIN authors a ON p.author_id = a.id
    ${whereClause}
    ORDER BY ${sortDef.column} ${sortDef.dir}, p.id ${sortDef.dir}
    LIMIT ?
  `;

  params.push(opts.limit + 1);

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();

  const rows = result.results as Record<string, unknown>[];
  const hasMore = rows.length > opts.limit;
  const items = (hasMore ? rows.slice(0, opts.limit) : rows).map(
    mapPluginSummary,
  );

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastRow = rows[opts.limit - 1];
    const sortColumn = sortDef.column.split(".")[1];
    nextCursor = encodeCursor(
      lastRow[sortColumn] as string | number,
      lastRow.id as string,
    );
  }

  return { items, nextCursor };
}

export async function getPluginDetail(
  db: D1Database,
  pluginId: string,
): Promise<MarketplacePluginDetail | null> {
  const [pluginResult, versionResult] = await db.batch([
    db
      .prepare(
        `SELECT p.*, a.github_username, a.avatar_url, a.verified
         FROM plugins p
         JOIN authors a ON p.author_id = a.id
         WHERE p.id = ? AND COALESCE(p.status, 'active') = 'active'
           AND EXISTS (SELECT 1 FROM plugin_versions pv0 WHERE pv0.plugin_id = p.id AND pv0.status IN ('published', 'flagged'))`,
      )
      .bind(pluginId),
    db
      .prepare(
        `SELECT pv.*, pa.verdict, pa.risk_score, pa.findings
         FROM plugin_versions pv
         LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
           AND pa.created_at = (SELECT MAX(pa2.created_at) FROM plugin_audits pa2 WHERE pa2.plugin_version_id = pv.id)
         WHERE pv.plugin_id = ? AND pv.status IN ('published', 'flagged')
         ORDER BY pv.created_at DESC
         LIMIT 1`,
      )
      .bind(pluginId),
  ]);

  const pluginRows = pluginResult.results as Record<string, unknown>[];
  if (pluginRows.length === 0) return null;

  const versionRows = versionResult.results as Record<string, unknown>[];
  const versionRow = versionRows.length > 0 ? versionRows[0] : null;

  return mapPluginDetail(pluginRows[0], versionRow);
}

export async function getPluginVersions(
  db: D1Database,
  pluginId: string,
): Promise<MarketplaceVersionSummary[]> {
  const result = await db
    .prepare(
      `SELECT pv.*, pa.verdict, pa.risk_score
       FROM plugin_versions pv
       LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
         AND pa.created_at = (SELECT MAX(pa2.created_at) FROM plugin_audits pa2 WHERE pa2.plugin_version_id = pv.id)
       WHERE pv.plugin_id = ?
       ORDER BY pv.created_at DESC`,
    )
    .bind(pluginId)
    .all();

  return (result.results as Record<string, unknown>[]).map(mapVersionSummary);
}

// --- Dashboard queries ---

export interface DashboardPlugin {
  id: string;
  name: string;
  latestVersion: string | null;
  latestStatus: string | null;
  installCount: number;
  updatedAt: string;
}

export async function getPluginsByAuthor(
  db: D1Database,
  authorId: string,
): Promise<DashboardPlugin[]> {
  const result = await db
    .prepare(
      `SELECT
        p.id, p.name, p.installs_count, p.updated_at,
        (SELECT pv.version FROM plugin_versions pv
         WHERE pv.plugin_id = p.id
         ORDER BY pv.created_at DESC LIMIT 1) AS latest_version,
        (SELECT pv.status FROM plugin_versions pv
         WHERE pv.plugin_id = p.id
         ORDER BY pv.created_at DESC LIMIT 1) AS latest_status
      FROM plugins p
      WHERE p.author_id = ?
      ORDER BY p.updated_at DESC`,
    )
    .bind(authorId)
    .all();

  return (result.results as Record<string, unknown>[]).map(mapDashboardPlugin);
}

/**
 * Trust tier shown to contributors and marketplace users. Derived at read
 * time from `plugin_versions.status` + the latest audit record's `model`
 * field — no D1 column, no migration. Keep this union in sync with
 * `TrustTierBadge.astro`.
 */
export type TrustTier =
  | "unreviewed"
  | "scanned"
  | "scanned-caution"
  | "ai-reviewed"
  | "ai-reviewed-caution"
  | "rejected";

export interface VersionDetail {
  version: string;
  status: "pending" | "published" | "flagged" | "rejected";
  retryCount: number;
  createdAt: string;
  verdict: "pass" | "warn" | "fail" | null;
  riskScore: number | null;
  findings: MarketplaceAuditFinding[];
  /**
   * The `model` column from the most recent audit record for this version.
   * Values in use: `'static-only'`, `'none'` (error path), AI model IDs
   * like `'@cf/meta/llama-3.2-3b-instruct'`, and `'admin-action'` for
   * manual approve/reject entries.
   */
  latestAuditModel: string | null;
  /** Derived trust tier for display — see `TrustTier` union above. */
  trustTier: TrustTier;
  /**
   * If the most recent admin-action audit carries a reason (`raw_response`
   * column), it surfaces here so the contributor can see why their version
   * was rejected. Null when the version has no admin-action history or
   * when the reason text is empty.
   */
  adminRejectionReason: string | null;
}

export async function getVersionDetail(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<VersionDetail | null> {
  // Primary query: latest audit (by created_at) joined to the version row.
  const primary = await db
    .prepare(
      `SELECT pv.version, pv.status, pv.retry_count, pv.created_at,
              pa.verdict, pa.risk_score, pa.findings, pa.model AS latest_audit_model
       FROM plugin_versions pv
       LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
         AND pa.created_at = (SELECT MAX(pa2.created_at) FROM plugin_audits pa2 WHERE pa2.plugin_version_id = pv.id)
       WHERE pv.plugin_id = ? AND pv.version = ?`,
    )
    .bind(pluginId, version)
    .all();

  const rows = primary.results as Record<string, unknown>[];
  if (rows.length === 0) return null;

  // Secondary query: the most recent admin-action audit (if any) for this
  // version. Kept separate from the primary join because correlating the
  // latest-overall audit with the latest-of-type audit inside one SQLite
  // subquery gets ugly fast.
  const adminAction = await db
    .prepare(
      `SELECT pa.raw_response
       FROM plugin_audits pa
       INNER JOIN plugin_versions pv ON pv.id = pa.plugin_version_id
       WHERE pv.plugin_id = ? AND pv.version = ? AND pa.model = 'admin-action'
       ORDER BY pa.created_at DESC
       LIMIT 1`,
    )
    .bind(pluginId, version)
    .first<{ raw_response: string }>();

  const adminRejectionReason =
    adminAction?.raw_response && adminAction.raw_response.trim().length > 0
      ? adminAction.raw_response
      : null;

  return mapVersionDetail(rows[0], adminRejectionReason);
}

// --- Theme queries ---

interface SearchThemesOpts {
  query: string;
  category: string | null;
  keyword: string | null;
  sort: string;
  cursor: string | null;
  limit: number;
}

const THEME_SORT_MAP: Record<string, { column: string; dir: "DESC" | "ASC" }> =
  {
    updated: { column: "t.updated_at", dir: "DESC" },
    created: { column: "t.created_at", dir: "DESC" },
    name: { column: "t.name", dir: "ASC" },
  };

export async function searchThemes(
  db: D1Database,
  opts: SearchThemesOpts,
): Promise<MarketplaceSearchResult<MarketplaceThemeSummary>> {
  const sortDef = THEME_SORT_MAP[opts.sort] ?? THEME_SORT_MAP.created;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.query) {
    conditions.push(
      "(t.name LIKE ? COLLATE NOCASE OR t.short_description LIKE ? COLLATE NOCASE OR t.description LIKE ? COLLATE NOCASE)",
    );
    const pattern = `%${opts.query}%`;
    params.push(pattern, pattern, pattern);
  }

  if (opts.category) {
    conditions.push("t.category = ?");
    params.push(opts.category);
  }

  if (opts.keyword) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(t.keywords) WHERE value = ?)",
    );
    params.push(opts.keyword);
  }

  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const op = sortDef.dir === "DESC" ? "<" : ">";
      conditions.push(`(${sortDef.column}, t.id) ${op} (?, ?)`);
      params.push(decoded.s, decoded.id);
    }
  }

  // Only show themes that have something to install
  conditions.push("(t.repository_url IS NOT NULL OR t.npm_package IS NOT NULL)");

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const sql = `
    SELECT t.*, a.github_username, a.avatar_url, a.verified
    FROM themes t
    JOIN authors a ON t.author_id = a.id
    ${whereClause}
    ORDER BY ${sortDef.column} ${sortDef.dir}, t.id ${sortDef.dir}
    LIMIT ?
  `;

  params.push(opts.limit + 1);

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();

  const rows = result.results as Record<string, unknown>[];
  const hasMore = rows.length > opts.limit;
  const items = (hasMore ? rows.slice(0, opts.limit) : rows).map(
    mapThemeSummary,
  );

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastRow = rows[opts.limit - 1];
    const sortColumn = sortDef.column.split(".")[1];
    nextCursor = encodeCursor(
      lastRow[sortColumn] as string | number,
      lastRow.id as string,
    );
  }

  return { items, nextCursor };
}

export async function getThemeDetail(
  db: D1Database,
  themeId: string,
): Promise<MarketplaceThemeDetail | null> {
  const result = await db
    .prepare(
      `SELECT t.*, a.github_username, a.avatar_url, a.verified
       FROM themes t
       JOIN authors a ON t.author_id = a.id
       WHERE t.id = ?
         AND (t.repository_url IS NOT NULL OR t.npm_package IS NOT NULL)`,
    )
    .bind(themeId)
    .all();

  const rows = result.results as Record<string, unknown>[];
  if (rows.length === 0) return null;

  return mapThemeDetail(rows[0]);
}
