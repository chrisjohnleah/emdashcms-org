/**
 * Per-author daily audit budget.
 * Caps AI audit invocations to prevent cost abuse.
 */

const DAILY_LIMIT = 10;

export async function checkAuthorAuditBudget(
  db: D1Database,
  authorId: string,
): Promise<{ allowed: boolean; used: number }> {
  const row = await db
    .prepare(
      "SELECT audit_count FROM author_audit_budget WHERE author_id = ? AND date = date('now')",
    )
    .bind(authorId)
    .first<{ audit_count: number }>();

  const used = row?.audit_count ?? 0;
  return { allowed: used < DAILY_LIMIT, used };
}

export async function recordAuthorAuditUsage(
  db: D1Database,
  authorId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO author_audit_budget (author_id, date, audit_count)
       VALUES (?, date('now'), 1)
       ON CONFLICT(author_id, date) DO UPDATE SET audit_count = audit_count + 1`,
    )
    .bind(authorId)
    .run();
}
