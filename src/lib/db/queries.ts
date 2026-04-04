import type {
  MarketplaceSearchResult,
  MarketplacePluginSummary,
  MarketplacePluginDetail,
  MarketplaceVersionSummary,
  MarketplaceThemeSummary,
  MarketplaceThemeDetail,
} from "../../types/marketplace";
import {
  mapPluginSummary,
  mapPluginDetail,
  mapVersionSummary,
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
      "(p.name LIKE ? COLLATE NOCASE OR p.description LIKE ? COLLATE NOCASE)",
    );
    const pattern = `%${opts.query}%`;
    params.push(pattern, pattern);
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

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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
         WHERE p.id = ?`,
      )
      .bind(pluginId),
    db
      .prepare(
        `SELECT pv.*, pa.verdict, pa.risk_score, pa.findings
         FROM plugin_versions pv
         LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
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
       WHERE pv.plugin_id = ?
       ORDER BY pv.created_at DESC`,
    )
    .bind(pluginId)
    .all();

  return (result.results as Record<string, unknown>[]).map(mapVersionSummary);
}

// --- Theme queries ---

interface SearchThemesOpts {
  query: string;
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
      "(t.name LIKE ? COLLATE NOCASE OR t.description LIKE ? COLLATE NOCASE)",
    );
    const pattern = `%${opts.query}%`;
    params.push(pattern, pattern);
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

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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
       WHERE t.id = ?`,
    )
    .bind(themeId)
    .all();

  const rows = result.results as Record<string, unknown>[];
  if (rows.length === 0) return null;

  return mapThemeDetail(rows[0]);
}
