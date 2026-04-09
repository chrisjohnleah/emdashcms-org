/**
 * Per-entity 24-hour spam cap for `report_filed` notifications (D-20).
 *
 * A single plugin or theme can only generate at most one report
 * notification per rolling 24-hour window, to keep the publisher's
 * inbox usable when a new plugin attracts a brigade of reports.
 *
 * Storage (12-RESEARCH.md Pattern 6): denormalized `last_report_notification_at`
 * TEXT column on `plugins` and `themes`. This is cheaper than a dedicated
 * cap table — no JOIN, one SELECT, one UPDATE — and implicitly self-cleans.
 *
 * Race note: there's a tiny window where two near-simultaneous reports
 * could both pass the SELECT before either UPDATE lands, yielding a
 * worst-case two notifications instead of one. At reporting volume this
 * is well within the spirit of the cap; the research explicitly accepts
 * this tradeoff.
 */

/**
 * Check whether a report_filed notification should fire for this entity.
 * When it returns `true`, it ALSO claims the 24h slot by updating
 * `last_report_notification_at` to the current timestamp.
 *
 * Callers should treat `false` as "silently suppress this send, do NOT
 * enqueue a NOTIF_QUEUE job".
 *
 * @param entityType  A typed union — 'plugin' | 'theme'. This is used
 *                    to whitelist the table name; NOT user input.
 */
export async function shouldSendReportNotification(
  db: D1Database,
  entityType: "plugin" | "theme",
  entityId: string,
): Promise<boolean> {
  // Table name is whitelisted from a typed union, NOT user input (T-02
  // mitigation in 12-01-PLAN.md threat model).
  const table = entityType === "plugin" ? "plugins" : "themes";

  // SELECT returns a row ONLY if the 24h window has passed OR the
  // column is NULL. If no row comes back, the entity is within the
  // window or the id doesn't exist — either way, suppress.
  const row = await db
    .prepare(
      `SELECT id FROM ${table}
       WHERE id = ?
         AND (last_report_notification_at IS NULL
              OR last_report_notification_at < strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-24 hours')))`,
    )
    .bind(entityId)
    .first();

  if (!row) return false;

  // Claim the slot atomically in the same call. The ternary below is
  // bound at TypeScript compile time to one of two safe string literals.
  await db
    .prepare(
      `UPDATE ${table}
       SET last_report_notification_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(entityId)
    .run();

  return true;
}
