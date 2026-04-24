/**
 * Pure D1 query module for the Phase 15 weekly transparency snapshot.
 *
 * Aggregation queries honour the PHYSICAL schema:
 *   - plugin_audits.created_at IS the audit completion timestamp.
 *     The original CONTEXT D-05 referenced a logical column name on
 *     plugin_versions for completion time; that column does not exist
 *     in migrations 0001/0002, so the join below is the source of truth.
 *   - "version revoked" is the physical proxy `plugin_audits.model =
 *     'admin-action'` written by the version-revoke admin path. The
 *     logical override column from D-05 also does not exist.
 *   - audit_budget.date is shaped 'YYYY-MM-DD' (migration 0004), so
 *     window bounds are sliced before binding.
 *   - All per-row created_at / resolved_at columns store ISO 'T...Z'
 *     timestamps — see Task 1 format audit in the test file's top
 *     comment block. Window bounds bind directly via toISOString().
 *
 * Plugin-level revokes (via admin/revoke.ts setPluginStatus) do NOT
 * write plugin_audits rows — they only touch plugins.status. So
 * versions_revoked counts version-level revokes only, which matches
 * the column name's intent.
 */

import { weekBoundsFor } from "./week-boundary";

export interface TransparencyWeekRow {
  iso_week: string;
  week_start: string;
  week_end: string;
  versions_submitted: number;
  versions_published: number;
  versions_flagged: number;
  versions_rejected: number;
  versions_revoked: number;
  reports_filed_security: number;
  reports_filed_abuse: number;
  reports_filed_broken: number;
  reports_filed_license: number;
  reports_filed_other: number;
  reports_resolved: number;
  reports_dismissed: number;
  neurons_spent: number;
  created_at: string;
}

export type TransparencyWeekSnapshot = Omit<TransparencyWeekRow, "created_at">;

/**
 * Compute the aggregated snapshot for one ISO week. Returns the row
 * shape ready to feed into upsertTransparencyWeek (without created_at,
 * which the table's strftime default supplies on INSERT).
 */
export async function computeWeeklySnapshot(
  db: D1Database,
  isoWeek: string,
): Promise<TransparencyWeekSnapshot> {
  const { start, end } = weekBoundsFor(isoWeek);
  const weekStart = start.toISOString();
  const weekEnd = end.toISOString();
  const weekStartDate = weekStart.slice(0, 10); // 'YYYY-MM-DD'
  const weekEndDate = weekEnd.slice(0, 10);

  // Submissions — D-08/D-09: every new version, scoped by plugin_versions.created_at.
  const submittedRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM plugin_versions
       WHERE created_at >= ? AND created_at < ?`,
    )
    .bind(weekStart, weekEnd)
    .first<{ c: number }>();

  // Audit outcomes — D-09: scoped by plugin_audits.created_at, joined to
  // plugin_versions.status. COUNT(*) so retries land in the same week
  // they completed in — see plan note on retries.
  const auditRows = await db
    .prepare(
      `SELECT pv.status AS status, COUNT(*) AS c
       FROM plugin_audits pa
       JOIN plugin_versions pv ON pa.plugin_version_id = pv.id
       WHERE pa.created_at >= ? AND pa.created_at < ?
         AND pa.status = 'complete'
         AND pv.status IN ('published', 'flagged', 'rejected')
       GROUP BY pv.status`,
    )
    .bind(weekStart, weekEnd)
    .all<{ status: string; c: number }>();

  let versionsPublished = 0;
  let versionsFlagged = 0;
  let versionsRejected = 0;
  for (const r of auditRows.results) {
    if (r.status === "published") versionsPublished = r.c;
    else if (r.status === "flagged") versionsFlagged = r.c;
    else if (r.status === "rejected") versionsRejected = r.c;
  }

  // Versions revoked — physical proxy via plugin_audits.model='admin-action'.
  // NOTE: plugin-level revokes (via admin/revoke.ts / setPluginStatus) do NOT
  // write plugin_audits rows and are intentionally NOT counted here.
  // versions_revoked counts version-level revokes only (via admin/revoke-version.ts).
  const revokedRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM plugin_audits
       WHERE created_at >= ? AND created_at < ?
         AND model = 'admin-action'
         AND status = 'complete'`,
    )
    .bind(weekStart, weekEnd)
    .first<{ c: number }>();

  // Reports filed by category — reports.reason_category CHECK enforces 5 values.
  const reportRows = await db
    .prepare(
      `SELECT reason_category, COUNT(*) AS c FROM reports
       WHERE created_at >= ? AND created_at < ?
       GROUP BY reason_category`,
    )
    .bind(weekStart, weekEnd)
    .all<{ reason_category: string; c: number }>();

  let reportsSecurity = 0;
  let reportsAbuse = 0;
  let reportsBroken = 0;
  let reportsLicense = 0;
  let reportsOther = 0;
  for (const r of reportRows.results) {
    switch (r.reason_category) {
      case "security":
        reportsSecurity = r.c;
        break;
      case "abuse":
        reportsAbuse = r.c;
        break;
      case "broken":
        reportsBroken = r.c;
        break;
      case "license":
        reportsLicense = r.c;
        break;
      case "other":
        reportsOther = r.c;
        break;
    }
  }

  // Reports resolved / dismissed — filtered by resolved_at in window.
  const closedRows = await db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM reports
       WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at < ?
       GROUP BY status`,
    )
    .bind(weekStart, weekEnd)
    .all<{ status: string; c: number }>();

  let reportsResolved = 0;
  let reportsDismissed = 0;
  for (const r of closedRows.results) {
    if (r.status === "resolved") reportsResolved = r.c;
    else if (r.status === "dismissed") reportsDismissed = r.c;
  }

  // Neurons spent — D-07. audit_budget.date is YYYY-MM-DD.
  const neuronsRow = await db
    .prepare(
      `SELECT COALESCE(SUM(neurons_used), 0) AS total FROM audit_budget
       WHERE date >= ? AND date < ?`,
    )
    .bind(weekStartDate, weekEndDate)
    .first<{ total: number }>();

  return {
    iso_week: isoWeek,
    week_start: weekStart,
    week_end: weekEnd,
    versions_submitted: submittedRow?.c ?? 0,
    versions_published: versionsPublished,
    versions_flagged: versionsFlagged,
    versions_rejected: versionsRejected,
    versions_revoked: revokedRow?.c ?? 0,
    reports_filed_security: reportsSecurity,
    reports_filed_abuse: reportsAbuse,
    reports_filed_broken: reportsBroken,
    reports_filed_license: reportsLicense,
    reports_filed_other: reportsOther,
    reports_resolved: reportsResolved,
    reports_dismissed: reportsDismissed,
    neurons_spent: neuronsRow?.total ?? 0,
  };
}

/**
 * Idempotent insert: re-running the cron for the same iso_week
 * overwrites the previous row in place. created_at uses the table
 * default (strftime ISO timestamp).
 */
export async function upsertTransparencyWeek(
  db: D1Database,
  row: TransparencyWeekSnapshot,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO transparency_weeks
        (iso_week, week_start, week_end, versions_submitted, versions_published,
         versions_flagged, versions_rejected, versions_revoked,
         reports_filed_security, reports_filed_abuse, reports_filed_broken,
         reports_filed_license, reports_filed_other, reports_resolved,
         reports_dismissed, neurons_spent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.iso_week,
      row.week_start,
      row.week_end,
      row.versions_submitted,
      row.versions_published,
      row.versions_flagged,
      row.versions_rejected,
      row.versions_revoked,
      row.reports_filed_security,
      row.reports_filed_abuse,
      row.reports_filed_broken,
      row.reports_filed_license,
      row.reports_filed_other,
      row.reports_resolved,
      row.reports_dismissed,
      row.neurons_spent,
    )
    .run();
}

export async function getLatestWeek(
  db: D1Database,
): Promise<TransparencyWeekRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM transparency_weeks ORDER BY iso_week DESC LIMIT 1`,
    )
    .first<TransparencyWeekRow>();
  return row ?? null;
}

export async function getWeekByIsoWeek(
  db: D1Database,
  isoWeek: string,
): Promise<TransparencyWeekRow | null> {
  const row = await db
    .prepare(`SELECT * FROM transparency_weeks WHERE iso_week = ?`)
    .bind(isoWeek)
    .first<TransparencyWeekRow>();
  return row ?? null;
}

/**
 * Newest-first listing. When `cursor` is provided, returns weeks
 * STRICTLY older than the cursor (used by /transparency/archive
 * pagination). Default page size 52 ≈ one calendar year.
 */
export async function listWeeks(
  db: D1Database,
  cursor?: string,
  limit = 52,
): Promise<TransparencyWeekRow[]> {
  const stmt = cursor
    ? db
        .prepare(
          `SELECT * FROM transparency_weeks WHERE iso_week < ?
           ORDER BY iso_week DESC LIMIT ?`,
        )
        .bind(cursor, limit)
    : db
        .prepare(
          `SELECT * FROM transparency_weeks
           ORDER BY iso_week DESC LIMIT ?`,
        )
        .bind(limit);
  const result = await stmt.all<TransparencyWeekRow>();
  return result.results;
}
