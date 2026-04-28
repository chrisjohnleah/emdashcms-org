import type { MemberId } from "./types";

/**
 * Returns true when the given member is an Author — that is, they own
 * at least one plugin or theme, or are listed as a collaborator on at
 * least one plugin.
 *
 * Read-only D1 query. Single prepared statement, UNION ALL across three
 * tables with LIMIT 1 so D1 short-circuits on first match — cheaper
 * than three separate queries and avoids the dedup pass we don't need
 * (UNION ALL skips it).
 *
 * No SQL injection surface: `memberId` is bound positionally three
 * times via the prepared statement. Same pattern as `checkPluginAccess`
 * in src/lib/auth/permissions.ts.
 */
export async function isAuthor(
  db: D1Database,
  memberId: MemberId,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM plugins WHERE author_id = ?
       UNION ALL
       SELECT 1 AS hit FROM themes WHERE author_id = ?
       UNION ALL
       SELECT 1 AS hit FROM plugin_collaborators WHERE author_id = ?
       LIMIT 1`,
    )
    .bind(memberId, memberId, memberId)
    .first<{ hit: number }>();

  return row !== null;
}
