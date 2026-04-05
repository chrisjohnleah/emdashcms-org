/**
 * D1 query functions for GitHub App installations and plugin-repo links.
 * Pure functions with db: D1Database as first param.
 * All timestamps use strftime('%Y-%m-%dT%H:%M:%SZ', 'now').
 */

export interface SaveInstallationInput {
  id: number;
  accountLogin: string;
  accountId: number;
  authorId: string;
}

export async function saveInstallation(
  db: D1Database,
  input: SaveInstallationInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO github_installations
       (id, account_login, account_id, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(input.id, input.accountLogin, input.accountId, input.authorId)
    .run();
}

export interface GitHubInstallation {
  id: number;
  accountLogin: string;
  accountId: number;
  authorId: string;
}

export async function getInstallation(
  db: D1Database,
  installationId: number,
): Promise<GitHubInstallation | null> {
  const row = await db
    .prepare("SELECT id, account_login, account_id, author_id FROM github_installations WHERE id = ?")
    .bind(installationId)
    .first<{ id: number; account_login: string; account_id: number; author_id: string }>();
  if (!row) return null;
  return {
    id: row.id,
    accountLogin: row.account_login,
    accountId: row.account_id,
    authorId: row.author_id,
  };
}

export async function getInstallationByAuthor(
  db: D1Database,
  authorId: string,
): Promise<GitHubInstallation | null> {
  const row = await db
    .prepare("SELECT id, account_login, account_id, author_id FROM github_installations WHERE author_id = ?")
    .bind(authorId)
    .first<{ id: number; account_login: string; account_id: number; author_id: string }>();
  if (!row) return null;
  return {
    id: row.id,
    accountLogin: row.account_login,
    accountId: row.account_id,
    authorId: row.author_id,
  };
}

export interface LinkPluginInput {
  pluginId: string;
  installationId: number;
  repoFullName: string;
  repoId: number;
}

export async function linkPluginToRepo(
  db: D1Database,
  input: LinkPluginInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO plugin_github_links
       (id, plugin_id, installation_id, repo_full_name, repo_id, auto_submit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(id, input.pluginId, input.installationId, input.repoFullName, input.repoId)
    .run();
  return id;
}

export interface PluginGitHubLink {
  id: string;
  pluginId: string;
  installationId: number;
  repoFullName: string;
  repoId: number;
  autoSubmit: boolean;
  tagPattern: string;
}

export async function getPluginGitHubLink(
  db: D1Database,
  pluginId: string,
): Promise<PluginGitHubLink | null> {
  const row = await db
    .prepare(
      "SELECT id, plugin_id, installation_id, repo_full_name, repo_id, auto_submit, tag_pattern FROM plugin_github_links WHERE plugin_id = ?",
    )
    .bind(pluginId)
    .first<{
      id: string;
      plugin_id: string;
      installation_id: number;
      repo_full_name: string;
      repo_id: number;
      auto_submit: number;
      tag_pattern: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    pluginId: row.plugin_id,
    installationId: row.installation_id,
    repoFullName: row.repo_full_name,
    repoId: row.repo_id,
    autoSubmit: row.auto_submit === 1,
    tagPattern: row.tag_pattern,
  };
}

export async function getLinkByRepoFullName(
  db: D1Database,
  repoFullName: string,
): Promise<(PluginGitHubLink & { authorId: string }) | null> {
  const row = await db
    .prepare(
      `SELECT l.id, l.plugin_id, l.installation_id, l.repo_full_name, l.repo_id, l.auto_submit,
              l.tag_pattern, i.author_id
       FROM plugin_github_links l
       JOIN github_installations i ON l.installation_id = i.id
       WHERE l.repo_full_name = ?`,
    )
    .bind(repoFullName)
    .first<{
      id: string;
      plugin_id: string;
      installation_id: number;
      repo_full_name: string;
      repo_id: number;
      auto_submit: number;
      tag_pattern: string;
      author_id: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    pluginId: row.plugin_id,
    installationId: row.installation_id,
    repoFullName: row.repo_full_name,
    repoId: row.repo_id,
    autoSubmit: row.auto_submit === 1,
    tagPattern: row.tag_pattern,
    authorId: row.author_id,
  };
}

export async function toggleAutoSubmit(
  db: D1Database,
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugin_github_links
       SET auto_submit = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE plugin_id = ?`,
    )
    .bind(enabled ? 1 : 0, pluginId)
    .run();
}

export async function unlinkPlugin(
  db: D1Database,
  pluginId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM plugin_github_links WHERE plugin_id = ?")
    .bind(pluginId)
    .run();
}

export async function setTagPattern(
  db: D1Database,
  pluginId: string,
  pattern: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugin_github_links
       SET tag_pattern = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE plugin_id = ?`,
    )
    .bind(pattern, pluginId)
    .run();
}
