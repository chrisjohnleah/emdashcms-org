/**
 * D1 query functions for the reports table and author ban actions.
 *
 * Reports track end-user and author-initiated complaints about plugins and
 * themes. Status lifecycle: open -> investigating -> resolved | dismissed.
 * Anonymous reports are allowed — `reporter_author_id` is nullable.
 */

export type ReportEntityType = "plugin" | "theme";
export type ReportCategory =
  | "security"
  | "abuse"
  | "broken"
  | "license"
  | "other";
export type ReportStatus =
  | "open"
  | "investigating"
  | "resolved"
  | "dismissed";

export interface Report {
  id: string;
  entityType: ReportEntityType;
  entityId: string;
  reporterAuthorId: string | null;
  reporterUsername: string | null;
  reasonCategory: ReportCategory;
  description: string;
  status: ReportStatus;
  resolutionNote: string | null;
  resolvedByAuthorId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateReportInput {
  entityType: ReportEntityType;
  entityId: string;
  reporterAuthorId: string | null;
  reasonCategory: ReportCategory;
  description: string;
}

/**
 * Insert a new report. Returns the generated report id.
 * Anonymous reports are allowed — pass reporterAuthorId=null.
 */
export async function createReport(
  db: D1Database,
  input: CreateReportInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO reports (
        id, entity_type, entity_id, reporter_author_id,
        reason_category, description, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(
      id,
      input.entityType,
      input.entityId,
      input.reporterAuthorId,
      input.reasonCategory,
      input.description,
    )
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List reports optionally filtered by status. Joins authors for the
 * reporter's GitHub username. Most recent first.
 */
export async function listReports(
  db: D1Database,
  status?: ReportStatus,
): Promise<Report[]> {
  const where = status ? "WHERE r.status = ?" : "";
  const binds = status ? [status] : [];

  const result = await db
    .prepare(
      `SELECT r.*, a.github_username AS reporter_username
       FROM reports r
       LEFT JOIN authors a ON a.id = r.reporter_author_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 200`,
    )
    .bind(...binds)
    .all();

  return (result.results as Record<string, unknown>[]).map(mapReport);
}

export async function getReport(
  db: D1Database,
  id: string,
): Promise<Report | null> {
  const row = await db
    .prepare(
      `SELECT r.*, a.github_username AS reporter_username
       FROM reports r
       LEFT JOIN authors a ON a.id = r.reporter_author_id
       WHERE r.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) return null;
  return mapReport(row);
}

/**
 * Count reports by status (for the admin queue tab badges).
 */
export async function countReportsByStatus(
  db: D1Database,
): Promise<Record<ReportStatus, number>> {
  const result = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM reports GROUP BY status`,
    )
    .all();

  const counts: Record<ReportStatus, number> = {
    open: 0,
    investigating: 0,
    resolved: 0,
    dismissed: 0,
  };
  for (const row of result.results as { status: ReportStatus; n: number }[]) {
    counts[row.status] = row.n;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Move a report through its status lifecycle. Writes resolution_note and
 * resolved_by_author_id when transitioning to resolved/dismissed.
 */
export async function updateReportStatus(
  db: D1Database,
  id: string,
  status: ReportStatus,
  resolutionNote: string | null,
  resolvedByAuthorId: string | null,
): Promise<boolean> {
  const isTerminal = status === "resolved" || status === "dismissed";
  const result = await db
    .prepare(
      `UPDATE reports
       SET status = ?,
           resolution_note = ?,
           resolved_by_author_id = CASE WHEN ? = 1 THEN ? ELSE NULL END,
           resolved_at = CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END
       WHERE id = ?`,
    )
    .bind(
      status,
      resolutionNote,
      isTerminal ? 1 : 0,
      resolvedByAuthorId,
      isTerminal ? 1 : 0,
      id,
    )
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Author ban actions (kept here because bans typically follow from a report)
// ---------------------------------------------------------------------------

export async function banAuthor(
  db: D1Database,
  authorId: string,
  reason: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE authors
       SET banned = 1,
           banned_reason = ?,
           banned_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(reason, authorId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function unbanAuthor(
  db: D1Database,
  authorId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE authors
       SET banned = 0,
           banned_reason = NULL,
           banned_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(authorId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mapReport(row: Record<string, unknown>): Report {
  return {
    id: row.id as string,
    entityType: row.entity_type as ReportEntityType,
    entityId: row.entity_id as string,
    reporterAuthorId: (row.reporter_author_id as string) ?? null,
    reporterUsername: (row.reporter_username as string) ?? null,
    reasonCategory: row.reason_category as ReportCategory,
    description: row.description as string,
    status: row.status as ReportStatus,
    resolutionNote: (row.resolution_note as string) ?? null,
    resolvedByAuthorId: (row.resolved_by_author_id as string) ?? null,
    resolvedAt: (row.resolved_at as string) ?? null,
    createdAt: row.created_at as string,
  };
}
