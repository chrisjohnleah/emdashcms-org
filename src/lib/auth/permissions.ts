/**
 * RBAC for plugin/theme write endpoints. `checkPluginAccess` and
 * `hasRole` are the public surface — every write route imports from
 * here.
 *
 * The Member identity model (every authenticated user) lives in
 * `src/lib/members/`. This file imports from there for read-side
 * queries (`isMemberAuthor`) but does NOT move `checkPluginAccess` —
 * its `author_id` parameter name matches the D1 column to keep the
 * wire-aligned naming intentional. See MEMB-07.
 */

/**
 * Centralized RBAC permission helper for plugin and theme access control.
 *
 * Replaces inline getPluginOwner/getThemeOwner checks across all write endpoints
 * with a single function that resolves the user's role on any entity.
 *
 * Ownership lives in plugins.author_id / themes.author_id (not in plugin_collaborators).
 * The UNION ALL approach checks both tables so callers skip specifying entity type.
 */

export type Role = 'owner' | 'maintainer' | 'contributor';

export type AccessResult =
  | { found: false }
  | { found: true; role: Role | null };

export const ROLE_HIERARCHY: Record<Role, number> = {
  owner: 3,
  maintainer: 2,
  contributor: 1,
};

/**
 * Check whether `userRole` meets or exceeds `requiredRole` in the hierarchy.
 *
 * owner >= maintainer >= contributor
 */
export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Check a user's access level for a plugin or theme.
 *
 * 1. Queries plugins + themes via UNION ALL to find the entity owner.
 * 2. If entity not found: { found: false }.
 * 3. If user is owner: { found: true, role: 'owner' }.
 * 4. Checks plugin_collaborators for a collaborator role.
 * 5. If collaborator: { found: true, role: <their role> }.
 * 6. Otherwise: { found: true, role: null } (entity exists but user has no access).
 */
export async function checkPluginAccess(
  db: D1Database,
  authorId: string,
  pluginId: string,
): Promise<AccessResult> {
  const entity = await db
    .prepare(
      'SELECT author_id FROM plugins WHERE id = ? UNION ALL SELECT author_id FROM themes WHERE id = ?',
    )
    .bind(pluginId, pluginId)
    .first<{ author_id: string }>();

  if (!entity) {
    return { found: false };
  }

  if (entity.author_id === authorId) {
    return { found: true, role: 'owner' };
  }

  const collab = await db
    .prepare(
      'SELECT role FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?',
    )
    .bind(pluginId, authorId)
    .first<{ role: Role }>();

  return { found: true, role: collab?.role ?? null };
}

// --- Member-identity delegation (Phase 23 / MEMB-01, MEMB-02) ---
//
// Re-exported so RBAC callers asking "is this member ANY kind of
// content owner?" can do so without importing two paths. The
// implementation lives in src/lib/members/derived-roles.ts; the
// re-export here exists only for ergonomics and to make the delegation
// discoverable from the RBAC entry-point file. checkPluginAccess SQL,
// signature, and behaviour are unchanged — see MEMB-07.
export { isAuthor as isMemberAuthor } from "../members/derived-roles";
export type { MemberId, AuthorId } from "../members/types";

