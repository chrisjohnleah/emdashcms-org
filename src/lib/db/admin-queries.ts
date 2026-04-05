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
