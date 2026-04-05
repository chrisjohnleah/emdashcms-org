/**
 * D1 query functions for collaborator and invite management.
 *
 * All functions accept `db: D1Database` as the first parameter (pure functions,
 * no `env` import). All timestamp writes use strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 * for ISO 8601 UTC format.
 *
 * plugin_id serves both plugins and themes (same pattern as plugin_github_links).
 */

import type { Role } from './permissions';

// --- Interfaces ---

export interface CreateInviteInput {
  pluginId: string;
  invitedGithubUsername: string;
  role: 'maintainer' | 'contributor';
  invitedBy: string;
  inviterGithubUsername: string;
}

export interface PendingInvite {
  id: string;
  pluginId: string;
  entityName: string;
  role: string;
  invitedBy: string;
  createdAt: string;
}

export interface Collaborator {
  id: string | null;
  authorId: string;
  githubUsername: string;
  role: Role;
  createdAt: string;
}

export interface DashboardPluginWithRole {
  id: string;
  name: string;
  latestVersion: string | null;
  latestStatus: string | null;
  installCount: number;
  updatedAt: string;
  role: Role;
}

export interface DashboardThemeWithRole {
  id: string;
  name: string;
  keywords: string[];
  license: string | null;
  updatedAt: string;
  role: Role;
}

export interface PluginInvite {
  id: string;
  invitedGithubUsername: string;
  role: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

// --- Invite CRUD ---

/**
 * Create a pending invite for a GitHub username to collaborate on a plugin/theme.
 *
 * Guards:
 * - Rejects self-invite (inviter's username matches invited username, case-insensitive)
 * - Rejects if user is already a collaborator on this entity
 * - Rejects if a pending non-expired invite already exists for this entity+username
 *
 * Expires after 30 days per D-04.
 */
export async function createInvite(
  db: D1Database,
  input: CreateInviteInput,
): Promise<string> {
  // Guard: self-invite
  if (
    input.inviterGithubUsername.toLowerCase() ===
    input.invitedGithubUsername.toLowerCase()
  ) {
    throw new Error('Cannot invite yourself');
  }

  // Guard: already a collaborator (resolve username to author_id first)
  const existingAuthor = await db
    .prepare(
      'SELECT id FROM authors WHERE github_username = ? COLLATE NOCASE',
    )
    .bind(input.invitedGithubUsername)
    .first<{ id: string }>();

  if (existingAuthor) {
    const existingCollab = await db
      .prepare(
        'SELECT 1 FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?',
      )
      .bind(input.pluginId, existingAuthor.id)
      .first();

    if (existingCollab) {
      throw new Error('User is already a collaborator on this entity');
    }
  }

  // Guard: duplicate pending invite
  const existingInvite = await db
    .prepare(
      `SELECT 1 FROM plugin_invites
       WHERE plugin_id = ? AND invited_github_username = ? COLLATE NOCASE
       AND status = 'pending'
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
    .bind(input.pluginId, input.invitedGithubUsername)
    .first();

  if (existingInvite) {
    throw new Error('A pending invite already exists for this user');
  }

  // Mark any expired pending invites as 'expired' to satisfy UNIQUE constraint
  await db
    .prepare(
      `UPDATE plugin_invites SET status = 'expired'
       WHERE plugin_id = ? AND invited_github_username = ? COLLATE NOCASE
       AND status = 'pending'
       AND expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
    .bind(input.pluginId, input.invitedGithubUsername)
    .run();

  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO plugin_invites (id, plugin_id, invited_github_username, role, invited_by, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '+30 days')))`,
    )
    .bind(
      id,
      input.pluginId,
      input.invitedGithubUsername,
      input.role,
      input.invitedBy,
    )
    .run();

  return id;
}

/**
 * Get all pending, non-expired invites for a GitHub username.
 * Joins with plugins/themes to get entity name and with authors to get inviter username.
 */
export async function getPendingInvitesForUser(
  db: D1Database,
  githubUsername: string,
): Promise<PendingInvite[]> {
  const result = await db
    .prepare(
      `SELECT i.id, i.plugin_id, i.role, i.created_at, a.github_username AS inviter_username,
              COALESCE(p.name, t.name) AS entity_name
       FROM plugin_invites i
       LEFT JOIN plugins p ON i.plugin_id = p.id
       LEFT JOIN themes t ON i.plugin_id = t.id
       JOIN authors a ON i.invited_by = a.id
       WHERE i.invited_github_username = ? COLLATE NOCASE
         AND i.status = 'pending'
         AND i.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       ORDER BY i.created_at DESC`,
    )
    .bind(githubUsername)
    .all();

  return (result.results as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    pluginId: row.plugin_id as string,
    entityName: (row.entity_name as string) ?? '',
    role: row.role as string,
    invitedBy: row.inviter_username as string,
    createdAt: row.created_at as string,
  }));
}

/**
 * Accept a pending invite: creates a collaborator record and marks the invite as accepted.
 * Uses db.batch() for atomicity.
 */
export async function acceptInvite(
  db: D1Database,
  inviteId: string,
  acceptingAuthorId: string,
): Promise<{ pluginId: string; role: string }> {
  const invite = await db
    .prepare(
      "SELECT * FROM plugin_invites WHERE id = ? AND status = 'pending'",
    )
    .bind(inviteId)
    .first<Record<string, unknown>>();

  if (!invite) {
    throw new Error('Invite not found or already processed');
  }

  const expiresAt = invite.expires_at as string;
  const now = new Date().toISOString();
  if (expiresAt < now) {
    throw new Error('Invite has expired');
  }

  const collabId = crypto.randomUUID();
  const pluginId = invite.plugin_id as string;
  const role = invite.role as string;

  await db.batch([
    db
      .prepare(
        `INSERT INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(collabId, pluginId, acceptingAuthorId, role),
    db
      .prepare("UPDATE plugin_invites SET status = 'accepted' WHERE id = ?")
      .bind(inviteId),
  ]);

  return { pluginId, role };
}

/**
 * Decline a pending invite. Verifies the invite belongs to the declining user.
 */
export async function declineInvite(
  db: D1Database,
  inviteId: string,
  decliningGithubUsername: string,
): Promise<void> {
  const invite = await db
    .prepare(
      "SELECT invited_github_username FROM plugin_invites WHERE id = ? AND status = 'pending'",
    )
    .bind(inviteId)
    .first<{ invited_github_username: string }>();

  if (!invite) {
    throw new Error('Invite not found or already processed');
  }

  if (
    invite.invited_github_username.toLowerCase() !==
    decliningGithubUsername.toLowerCase()
  ) {
    throw new Error('This invite does not belong to you');
  }

  await db
    .prepare("UPDATE plugin_invites SET status = 'declined' WHERE id = ?")
    .bind(inviteId)
    .run();
}

// --- Collaborator CRUD ---

/**
 * Get all collaborators for a plugin/theme, including the owner.
 * Owner is listed first with role 'owner'.
 */
export async function getCollaborators(
  db: D1Database,
  pluginId: string,
): Promise<Collaborator[]> {
  // Get owner from plugins or themes
  const ownerRow = await db
    .prepare(
      `SELECT p.author_id, a.github_username, p.created_at
       FROM plugins p JOIN authors a ON p.author_id = a.id WHERE p.id = ?
       UNION ALL
       SELECT t.author_id, a.github_username, t.created_at
       FROM themes t JOIN authors a ON t.author_id = a.id WHERE t.id = ?`,
    )
    .bind(pluginId, pluginId)
    .first<{ author_id: string; github_username: string; created_at: string }>();

  const collaborators: Collaborator[] = [];

  if (ownerRow) {
    collaborators.push({
      id: null,
      authorId: ownerRow.author_id,
      githubUsername: ownerRow.github_username,
      role: 'owner',
      createdAt: ownerRow.created_at,
    });
  }

  const result = await db
    .prepare(
      `SELECT c.id, c.author_id, c.role, c.created_at, a.github_username
       FROM plugin_collaborators c
       JOIN authors a ON c.author_id = a.id
       WHERE c.plugin_id = ?
       ORDER BY c.created_at ASC`,
    )
    .bind(pluginId)
    .all();

  for (const row of result.results as Record<string, unknown>[]) {
    collaborators.push({
      id: row.id as string,
      authorId: row.author_id as string,
      githubUsername: row.github_username as string,
      role: row.role as Role,
      createdAt: row.created_at as string,
    });
  }

  return collaborators;
}

/**
 * Remove a collaborator from a plugin/theme.
 */
export async function removeCollaborator(
  db: D1Database,
  pluginId: string,
  collaboratorAuthorId: string,
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?',
    )
    .bind(pluginId, collaboratorAuthorId)
    .run();
}

/**
 * Update a collaborator's role in-place (D-05).
 * Single UPDATE query, no revoke+re-invite.
 */
export async function updateCollaboratorRole(
  db: D1Database,
  pluginId: string,
  collaboratorAuthorId: string,
  newRole: 'maintainer' | 'contributor',
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugin_collaborators
       SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE plugin_id = ? AND author_id = ?`,
    )
    .bind(newRole, pluginId, collaboratorAuthorId)
    .run();
}

// --- Ownership Transfer ---

/**
 * Atomically transfer ownership of a plugin or theme (D-15).
 *
 * 1. Update entity owner to new owner
 * 2. Remove new owner from collaborators (they are now the entity owner)
 * 3. Add previous owner as maintainer collaborator
 *
 * Uses db.batch() for atomicity per Pitfall 2.
 */
export async function transferOwnership(
  db: D1Database,
  pluginId: string,
  currentOwnerId: string,
  newOwnerId: string,
  entityType: 'plugin' | 'theme',
): Promise<void> {
  const table = entityType === 'plugin' ? 'plugins' : 'themes';
  const collabId = crypto.randomUUID();

  await db.batch([
    db
      .prepare(
        `UPDATE ${table} SET author_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
      )
      .bind(newOwnerId, pluginId),
    db
      .prepare(
        'DELETE FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?',
      )
      .bind(pluginId, newOwnerId),
    db
      .prepare(
        `INSERT OR REPLACE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
         VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(collabId, pluginId, currentOwnerId),
  ]);
}

// --- Cascade Deletion ---

/**
 * Delete a plugin and all related records atomically.
 *
 * Cascade order: plugin_invites, plugin_collaborators, plugin_github_links,
 * plugin_audits, plugin_versions, installs, plugins.
 *
 * After D1 success, best-effort R2 cleanup of bundle files.
 */
export async function deletePlugin(
  db: D1Database,
  r2: R2Bucket,
  pluginId: string,
): Promise<void> {
  // Fetch R2 keys before deletion
  const versions = await db
    .prepare('SELECT bundle_key FROM plugin_versions WHERE plugin_id = ?')
    .bind(pluginId)
    .all<{ bundle_key: string }>();

  // Cascade delete in D1
  await db.batch([
    db.prepare('DELETE FROM plugin_invites WHERE plugin_id = ?').bind(pluginId),
    db
      .prepare('DELETE FROM plugin_collaborators WHERE plugin_id = ?')
      .bind(pluginId),
    db
      .prepare('DELETE FROM plugin_github_links WHERE plugin_id = ?')
      .bind(pluginId),
    db
      .prepare(
        'DELETE FROM plugin_audits WHERE plugin_version_id IN (SELECT id FROM plugin_versions WHERE plugin_id = ?)',
      )
      .bind(pluginId),
    db
      .prepare('DELETE FROM plugin_versions WHERE plugin_id = ?')
      .bind(pluginId),
    db.prepare('DELETE FROM installs WHERE plugin_id = ?').bind(pluginId),
    db.prepare('DELETE FROM plugins WHERE id = ?').bind(pluginId),
  ]);

  // Best-effort R2 cleanup
  for (const v of versions.results) {
    try {
      await r2.delete(v.bundle_key);
    } catch {
      // Best-effort: log in production, ignore in tests
    }
  }
}

/**
 * Delete a theme and all related records atomically.
 *
 * Cascade order: plugin_invites, plugin_collaborators, plugin_github_links, themes.
 *
 * After D1 success, best-effort R2 cleanup of thumbnail and screenshots.
 */
export async function deleteTheme(
  db: D1Database,
  r2: R2Bucket,
  themeId: string,
): Promise<void> {
  // Fetch R2 keys before deletion
  const theme = await db
    .prepare('SELECT thumbnail_key, screenshot_keys FROM themes WHERE id = ?')
    .bind(themeId)
    .first<{ thumbnail_key: string | null; screenshot_keys: string | null }>();

  // Cascade delete in D1
  await db.batch([
    db.prepare('DELETE FROM plugin_invites WHERE plugin_id = ?').bind(themeId),
    db
      .prepare('DELETE FROM plugin_collaborators WHERE plugin_id = ?')
      .bind(themeId),
    db
      .prepare('DELETE FROM plugin_github_links WHERE plugin_id = ?')
      .bind(themeId),
    db.prepare('DELETE FROM themes WHERE id = ?').bind(themeId),
  ]);

  // Best-effort R2 cleanup
  if (theme) {
    const keysToDelete: string[] = [];
    if (theme.thumbnail_key) {
      keysToDelete.push(theme.thumbnail_key);
    }
    if (theme.screenshot_keys) {
      const screenshots: string[] = JSON.parse(theme.screenshot_keys);
      keysToDelete.push(...screenshots);
    }
    for (const key of keysToDelete) {
      try {
        await r2.delete(key);
      } catch {
        // Best-effort
      }
    }
  }
}

// --- Dashboard Queries ---

/**
 * Get all plugins a user owns or collaborates on, with role field.
 * Uses UNION ALL: owned plugins (role='owner') + collaborated plugins (role from table).
 */
export async function getDashboardPlugins(
  db: D1Database,
  authorId: string,
): Promise<DashboardPluginWithRole[]> {
  const result = await db
    .prepare(
      `SELECT p.id, p.name, p.installs_count, p.updated_at, 'owner' AS role,
        (SELECT pv.version FROM plugin_versions pv WHERE pv.plugin_id = p.id ORDER BY pv.created_at DESC LIMIT 1) AS latest_version,
        (SELECT pv.status FROM plugin_versions pv WHERE pv.plugin_id = p.id ORDER BY pv.created_at DESC LIMIT 1) AS latest_status
       FROM plugins p WHERE p.author_id = ?
       UNION ALL
       SELECT p.id, p.name, p.installs_count, p.updated_at, c.role,
        (SELECT pv.version FROM plugin_versions pv WHERE pv.plugin_id = p.id ORDER BY pv.created_at DESC LIMIT 1) AS latest_version,
        (SELECT pv.status FROM plugin_versions pv WHERE pv.plugin_id = p.id ORDER BY pv.created_at DESC LIMIT 1) AS latest_status
       FROM plugins p
       JOIN plugin_collaborators c ON p.id = c.plugin_id
       WHERE c.author_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(authorId, authorId)
    .all();

  return (result.results as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    latestVersion: (row.latest_version as string) ?? null,
    latestStatus: (row.latest_status as string) ?? null,
    installCount: (row.installs_count as number) ?? 0,
    updatedAt: row.updated_at as string,
    role: row.role as Role,
  }));
}

/**
 * Get all themes a user owns or collaborates on, with role field.
 */
export async function getDashboardThemes(
  db: D1Database,
  authorId: string,
): Promise<DashboardThemeWithRole[]> {
  const result = await db
    .prepare(
      `SELECT t.id, t.name, t.keywords, t.license, t.updated_at, 'owner' AS role
       FROM themes t WHERE t.author_id = ?
       UNION ALL
       SELECT t.id, t.name, t.keywords, t.license, t.updated_at, c.role
       FROM themes t
       JOIN plugin_collaborators c ON t.id = c.plugin_id
       WHERE c.author_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(authorId, authorId)
    .all();

  return (result.results as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    keywords: JSON.parse((row.keywords as string) || '[]'),
    license: (row.license as string) ?? null,
    updatedAt: row.updated_at as string,
    role: row.role as Role,
  }));
}

/**
 * Get pending non-expired invites for a specific plugin/theme.
 * Used for the team section display on the detail page.
 */
export async function getPendingInvitesForPlugin(
  db: D1Database,
  pluginId: string,
): Promise<PluginInvite[]> {
  const result = await db
    .prepare(
      `SELECT i.id, i.invited_github_username, i.role, i.created_at, i.expires_at,
              a.github_username AS inviter_username
       FROM plugin_invites i
       JOIN authors a ON i.invited_by = a.id
       WHERE i.plugin_id = ?
         AND i.status = 'pending'
         AND i.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       ORDER BY i.created_at DESC`,
    )
    .bind(pluginId)
    .all();

  return (result.results as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    invitedGithubUsername: row.invited_github_username as string,
    role: row.role as string,
    invitedBy: row.inviter_username as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  }));
}
