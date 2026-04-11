// Phase 14: D1 query helpers for feeds. Pure functions — `db` is the
// first parameter, no `env` import. Each helper runs a single, focused
// query tuned for the feed use case; cursor pagination and the full
// `searchPlugins` filter matrix are intentionally NOT reused because
// feeds only need "the N most recent rows matching the active filter".
//
// See 14-RESEARCH.md §6 for the canonical SQL shapes and rationale.

export interface FeedPluginRow {
  id: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  category: string | null;
  createdAt: string;
  authorLogin: string;
}

export interface FeedPluginVersionRow {
  pluginId: string;
  name: string;
  version: string;
  shortDescription: string | null;
  description: string | null;
  category: string | null;
  /** Coalesced `published_at ?? created_at` — matches the sort expression. */
  publishedAt: string;
  authorLogin: string;
}

export interface FeedThemeRow {
  id: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  createdAt: string;
  authorLogin: string;
}

// ---------------------------------------------------------------------------
// SQL — kept at module scope so each query shape is obvious at a glance and
// easy to grep. Every query binds its LIMIT via `?` to keep it parameterized.
// ---------------------------------------------------------------------------

const RECENT_PLUGINS_SQL = `
  SELECT
    p.id,
    p.name,
    p.short_description,
    p.description,
    p.category,
    p.created_at,
    a.github_username AS author_login
  FROM plugins p
  JOIN authors a ON p.author_id = a.id
  WHERE COALESCE(p.status, 'active') = 'active'
    AND EXISTS (
      SELECT 1 FROM plugin_versions pv
      WHERE pv.plugin_id = p.id AND pv.status IN ('published', 'flagged')
    )
  ORDER BY p.created_at DESC
  LIMIT ?
`;

const RECENT_PLUGIN_VERSIONS_SQL = `
  SELECT
    pv.version,
    pv.published_at,
    pv.created_at AS version_created_at,
    p.id AS plugin_id,
    p.name,
    p.short_description,
    p.description,
    p.category,
    a.github_username AS author_login
  FROM plugin_versions pv
  JOIN plugins p ON p.id = pv.plugin_id
  JOIN authors a ON a.id = p.author_id
  WHERE pv.status IN ('published', 'flagged')
    AND COALESCE(p.status, 'active') = 'active'
  ORDER BY COALESCE(pv.published_at, pv.created_at) DESC
  LIMIT ?
`;

const RECENT_THEMES_SQL = `
  SELECT
    t.id,
    t.name,
    t.short_description,
    t.description,
    t.created_at,
    a.github_username AS author_login
  FROM themes t
  JOIN authors a ON a.id = t.author_id
  WHERE t.repository_url IS NOT NULL OR t.npm_package IS NOT NULL
  ORDER BY t.created_at DESC
  LIMIT ?
`;

const PLUGINS_BY_CATEGORY_SQL = `
  SELECT
    p.id,
    p.name,
    p.short_description,
    p.description,
    p.category,
    p.created_at,
    a.github_username AS author_login
  FROM plugins p
  JOIN authors a ON p.author_id = a.id
  WHERE COALESCE(p.status, 'active') = 'active'
    AND p.category = ?
    AND EXISTS (
      SELECT 1 FROM plugin_versions pv
      WHERE pv.plugin_id = p.id AND pv.status IN ('published', 'flagged')
    )
  ORDER BY p.created_at DESC
  LIMIT ?
`;

// ---------------------------------------------------------------------------

interface PluginRowRaw {
  id: string;
  name: string;
  short_description: string | null;
  description: string | null;
  category: string | null;
  created_at: string;
  author_login: string;
}

interface PluginVersionRowRaw {
  version: string;
  published_at: string | null;
  version_created_at: string;
  plugin_id: string;
  name: string;
  short_description: string | null;
  description: string | null;
  category: string | null;
  author_login: string;
}

interface ThemeRowRaw {
  id: string;
  name: string;
  short_description: string | null;
  description: string | null;
  created_at: string;
  author_login: string;
}

function mapPluginRow(row: PluginRowRaw): FeedPluginRow {
  return {
    id: row.id,
    name: row.name,
    shortDescription: row.short_description ?? null,
    description: row.description ?? null,
    category: row.category ?? null,
    createdAt: row.created_at,
    authorLogin: row.author_login,
  };
}

export async function listRecentPluginsForFeed(
  db: D1Database,
  limit: number,
): Promise<FeedPluginRow[]> {
  const r = await db.prepare(RECENT_PLUGINS_SQL).bind(limit).all<PluginRowRaw>();
  return (r.results ?? []).map(mapPluginRow);
}

export async function listRecentPluginVersionsForFeed(
  db: D1Database,
  limit: number,
): Promise<FeedPluginVersionRow[]> {
  const r = await db
    .prepare(RECENT_PLUGIN_VERSIONS_SQL)
    .bind(limit)
    .all<PluginVersionRowRaw>();
  return (r.results ?? []).map(
    (row): FeedPluginVersionRow => ({
      pluginId: row.plugin_id,
      name: row.name,
      version: row.version,
      shortDescription: row.short_description ?? null,
      description: row.description ?? null,
      category: row.category ?? null,
      // Coalesce matches the ORDER BY expression so <updated> and sort agree.
      publishedAt: row.published_at ?? row.version_created_at,
      authorLogin: row.author_login,
    }),
  );
}

export async function listRecentThemesForFeed(
  db: D1Database,
  limit: number,
): Promise<FeedThemeRow[]> {
  const r = await db.prepare(RECENT_THEMES_SQL).bind(limit).all<ThemeRowRaw>();
  return (r.results ?? []).map(
    (row): FeedThemeRow => ({
      id: row.id,
      name: row.name,
      shortDescription: row.short_description ?? null,
      description: row.description ?? null,
      createdAt: row.created_at,
      authorLogin: row.author_login,
    }),
  );
}

export async function listPluginsByCategoryForFeed(
  db: D1Database,
  category: string,
  limit: number,
): Promise<FeedPluginRow[]> {
  const r = await db
    .prepare(PLUGINS_BY_CATEGORY_SQL)
    .bind(category, limit)
    .all<PluginRowRaw>();
  return (r.results ?? []).map(mapPluginRow);
}
