export interface AdminPlugin {
  id: string;
  name: string;
  status: string;
  authorUsername: string;
  authorId: string;
  installCount: number;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAuthor {
  id: string;
  githubUsername: string;
  githubId: number;
  avatarUrl: string | null;
  pluginCount: number;
  themeCount: number;
  createdAt: string;
}

export async function getAllPlugins(db: D1Database): Promise<AdminPlugin[]> {
  const result = await db
    .prepare(
      `SELECT
        p.id, p.name, COALESCE(p.status, 'active') AS status,
        p.author_id, p.installs_count, p.created_at, p.updated_at,
        a.github_username,
        (SELECT COUNT(*) FROM plugin_versions pv WHERE pv.plugin_id = p.id) AS version_count
      FROM plugins p
      JOIN authors a ON p.author_id = a.id
      ORDER BY p.created_at DESC`,
    )
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    authorUsername: r.github_username as string,
    authorId: r.author_id as string,
    installCount: r.installs_count as number,
    versionCount: r.version_count as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export async function getAllAuthors(db: D1Database): Promise<AdminAuthor[]> {
  const result = await db
    .prepare(
      `SELECT
        a.*,
        (SELECT COUNT(*) FROM plugins p WHERE p.author_id = a.id) AS plugin_count,
        (SELECT COUNT(*) FROM themes t WHERE t.author_id = a.id) AS theme_count
      FROM authors a
      ORDER BY a.created_at DESC`,
    )
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    githubUsername: r.github_username as string,
    githubId: r.github_id as number,
    avatarUrl: r.avatar_url as string | null,
    pluginCount: r.plugin_count as number,
    themeCount: r.theme_count as number,
    createdAt: r.created_at as string,
  }));
}

export async function setPluginStatus(
  db: D1Database,
  pluginId: string,
  status: "active" | "revoked",
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE plugins SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(status, pluginId)
    .run();

  return result.meta.changes > 0;
}

export async function deletePlugin(
  db: D1Database,
  pluginId: string,
): Promise<{ versionIds: string[] }> {
  // Get version IDs for R2 cleanup
  const versions = await db
    .prepare(`SELECT id FROM plugin_versions WHERE plugin_id = ?`)
    .bind(pluginId)
    .all();

  const versionIds = (versions.results as { id: string }[]).map((r) => r.id);

  // Delete in order: audits → versions → github links → plugin
  await db.batch([
    db
      .prepare(
        `DELETE FROM plugin_audits WHERE plugin_version_id IN (
          SELECT id FROM plugin_versions WHERE plugin_id = ?
        )`,
      )
      .bind(pluginId),
    db
      .prepare(`DELETE FROM plugin_versions WHERE plugin_id = ?`)
      .bind(pluginId),
    db
      .prepare(`DELETE FROM plugin_github_links WHERE plugin_id = ?`)
      .bind(pluginId),
    db.prepare(`DELETE FROM plugins WHERE id = ?`).bind(pluginId),
  ]);

  return { versionIds };
}

// --- Admin detail types ---

export interface AdminPluginDetail {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  capabilities: string[];
  keywords: string[];
  license: string | null;
  repositoryUrl: string | null;
  homepageUrl: string | null;
  status: string;
  installCount: number;
  createdAt: string;
  updatedAt: string;
  authorId: string;
  authorUsername: string;
  authorAvatarUrl: string | null;
  authorGithubId: number;
  githubRepoFullName: string | null;
  githubAutoSubmit: boolean | null;
  githubTagPattern: string | null;
}

export interface AdminVersionDetail {
  id: string;
  version: string;
  status: string;
  retryCount: number;
  source: string | null;
  compressedSize: number;
  createdAt: string;
  verdict: string | null;
  riskScore: number | null;
  findings: { severity: string; title: string; description: string; category: string; location: string | null }[];
  rawResponse: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  neuronsUsed: number | null;
}

export interface AuthorPlugin {
  id: string;
  name: string;
  status: string;
  installCount: number;
  versionCount: number;
  rejectedCount: number;
  latestVersion: string | null;
  createdAt: string;
}

export interface AuthorTheme {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface SubmissionStats {
  total: number;
  published: number;
  rejected: number;
  flagged: number;
  pending: number;
}

export interface ModerationQueueItem {
  pluginId: string;
  pluginName: string;
  versionId: string;
  version: string;
  status: string;
  retryCount: number;
  source: string | null;
  verdict: string | null;
  riskScore: number | null;
  authorUsername: string;
  authorId: string;
  createdAt: string;
}

// --- Admin detail queries ---

export async function getAdminPluginDetail(
  db: D1Database,
  pluginId: string,
): Promise<AdminPluginDetail | null> {
  const result = await db
    .prepare(
      `SELECT p.*, a.github_username, a.avatar_url, a.github_id,
              gl.repo_full_name, gl.auto_submit, gl.tag_pattern
       FROM plugins p
       JOIN authors a ON p.author_id = a.id
       LEFT JOIN plugin_github_links gl ON gl.plugin_id = p.id
       WHERE p.id = ?`,
    )
    .bind(pluginId)
    .all();

  const rows = result.results as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    category: r.category as string | null,
    capabilities: JSON.parse((r.capabilities as string) || "[]"),
    keywords: JSON.parse((r.keywords as string) || "[]"),
    license: r.license as string | null,
    repositoryUrl: r.repository_url as string | null,
    homepageUrl: r.homepage_url as string | null,
    status: (r.status as string) ?? "active",
    installCount: r.installs_count as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    authorId: r.author_id as string,
    authorUsername: r.github_username as string,
    authorAvatarUrl: r.avatar_url as string | null,
    authorGithubId: r.github_id as number,
    githubRepoFullName: r.repo_full_name as string | null,
    githubAutoSubmit: r.auto_submit != null ? Boolean(r.auto_submit) : null,
    githubTagPattern: r.tag_pattern as string | null,
  };
}

export async function getAdminPluginVersions(
  db: D1Database,
  pluginId: string,
): Promise<AdminVersionDetail[]> {
  const result = await db
    .prepare(
      `SELECT pv.*, pa.verdict, pa.risk_score, pa.findings, pa.raw_response,
              pa.model, pa.prompt_tokens, pa.completion_tokens, pa.neurons_used
       FROM plugin_versions pv
       LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
       WHERE pv.plugin_id = ?
       ORDER BY pv.created_at DESC`,
    )
    .bind(pluginId)
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    version: r.version as string,
    status: r.status as string,
    retryCount: (r.retry_count as number) ?? 0,
    source: r.source as string | null,
    compressedSize: (r.compressed_size as number) ?? 0,
    createdAt: r.created_at as string,
    verdict: r.verdict as string | null,
    riskScore: r.risk_score as number | null,
    findings: JSON.parse((r.findings as string) || "[]"),
    rawResponse: r.raw_response as string | null,
    model: r.model as string | null,
    promptTokens: r.prompt_tokens as number | null,
    completionTokens: r.completion_tokens as number | null,
    neuronsUsed: r.neurons_used as number | null,
  }));
}

export async function getAdminAuthorDetail(
  db: D1Database,
  authorId: string,
): Promise<AdminAuthor | null> {
  const result = await db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM plugins p WHERE p.author_id = a.id) AS plugin_count,
              (SELECT COUNT(*) FROM themes t WHERE t.author_id = a.id) AS theme_count
       FROM authors a WHERE a.id = ?`,
    )
    .bind(authorId)
    .all();

  const rows = result.results as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    id: r.id as string,
    githubUsername: r.github_username as string,
    githubId: r.github_id as number,
    avatarUrl: r.avatar_url as string | null,
    pluginCount: r.plugin_count as number,
    themeCount: r.theme_count as number,
    createdAt: r.created_at as string,
  };
}

export async function getAuthorPlugins(
  db: D1Database,
  authorId: string,
): Promise<AuthorPlugin[]> {
  const result = await db
    .prepare(
      `SELECT p.id, p.name, COALESCE(p.status, 'active') AS status,
              p.installs_count, p.created_at,
              (SELECT COUNT(*) FROM plugin_versions pv WHERE pv.plugin_id = p.id) AS version_count,
              (SELECT COUNT(*) FROM plugin_versions pv WHERE pv.plugin_id = p.id AND pv.status = 'rejected') AS rejected_count,
              (SELECT pv.version FROM plugin_versions pv WHERE pv.plugin_id = p.id ORDER BY pv.created_at DESC LIMIT 1) AS latest_version
       FROM plugins p WHERE p.author_id = ?
       ORDER BY p.created_at DESC`,
    )
    .bind(authorId)
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    installCount: r.installs_count as number,
    versionCount: r.version_count as number,
    rejectedCount: r.rejected_count as number,
    latestVersion: r.latest_version as string | null,
    createdAt: r.created_at as string,
  }));
}

export async function getAuthorThemes(
  db: D1Database,
  authorId: string,
): Promise<AuthorTheme[]> {
  const result = await db
    .prepare(
      `SELECT id, name, description, created_at
       FROM themes WHERE author_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(authorId)
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    createdAt: r.created_at as string,
  }));
}

export async function getAuthorSubmissionStats(
  db: D1Database,
  authorId: string,
): Promise<SubmissionStats> {
  const result = await db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN pv.status = 'published' THEN 1 ELSE 0 END) AS published,
        SUM(CASE WHEN pv.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN pv.status = 'flagged' THEN 1 ELSE 0 END) AS flagged,
        SUM(CASE WHEN pv.status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM plugin_versions pv
       JOIN plugins p ON pv.plugin_id = p.id
       WHERE p.author_id = ?`,
    )
    .bind(authorId)
    .all();

  const r = (result.results as Record<string, unknown>[])[0] ?? {};
  return {
    total: (r.total as number) ?? 0,
    published: (r.published as number) ?? 0,
    rejected: (r.rejected as number) ?? 0,
    flagged: (r.flagged as number) ?? 0,
    pending: (r.pending as number) ?? 0,
  };
}

export async function getModerationQueue(
  db: D1Database,
): Promise<ModerationQueueItem[]> {
  const result = await db
    .prepare(
      `SELECT pv.id AS version_id, pv.plugin_id, pv.version, pv.status, pv.retry_count, pv.source, pv.created_at,
              pa.verdict, pa.risk_score,
              p.name AS plugin_name, p.author_id,
              a.github_username
       FROM plugin_versions pv
       LEFT JOIN plugin_audits pa ON pa.plugin_version_id = pv.id
       JOIN plugins p ON pv.plugin_id = p.id
       JOIN authors a ON p.author_id = a.id
       WHERE pv.status IN ('pending', 'flagged', 'rejected')
       ORDER BY
         CASE pv.status WHEN 'pending' THEN 0 WHEN 'flagged' THEN 1 WHEN 'rejected' THEN 2 END,
         pv.created_at DESC
       LIMIT 100`,
    )
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    pluginId: r.plugin_id as string,
    pluginName: r.plugin_name as string,
    versionId: r.version_id as string,
    version: r.version as string,
    status: r.status as string,
    retryCount: (r.retry_count as number) ?? 0,
    source: r.source as string | null,
    verdict: r.verdict as string | null,
    riskScore: r.risk_score as number | null,
    authorUsername: r.github_username as string,
    authorId: r.author_id as string,
    createdAt: r.created_at as string,
  }));
}
