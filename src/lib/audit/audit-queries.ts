/**
 * D1 query functions for audit record creation and version status updates.
 *
 * All functions accept `db: D1Database` as the first parameter (pure functions,
 * no `env` import). Timestamps use strftime('%Y-%m-%dT%H:%M:%SZ', 'now').
 */
import type { MarketplaceAuditFinding } from "../../types/marketplace";

// --- Interfaces ---

export interface CreateAuditParams {
  versionId: string;
  status: "complete" | "error";
  model: string;
  promptTokens: number;
  completionTokens: number;
  neuronsUsed: number;
  rawResponse: string;
  verdict: "pass" | "warn" | "fail" | null;
  riskScore: number;
  findings: MarketplaceAuditFinding[];
  /**
   * Optional override for the version status update.
   * - If unset and verdict is non-null, uses verdictToStatus(verdict).
   * - If unset and verdict is null, defaults to 'rejected' (legacy
   *   fail-closed behaviour for hard error paths).
   * - If set explicitly, that status is used regardless of verdict —
   *   used by static-only scans to leave the version 'pending' while
   *   still recording findings.
   */
  versionStatusOverride?:
    | "pending"
    | "published"
    | "flagged"
    | "rejected"
    | "revoked";
  /**
   * When set, marks this audit record's raw_response as publicly visible
   * on the plugin detail page. Defaults to false (private) so existing
   * callers keep the old behavior. Admin reject/revoke actions set this
   * based on the "Post note publicly" checkbox.
   */
  publicNote?: boolean;
}

// --- Verdict Mapping ---

/**
 * Map an AI audit verdict to the corresponding version status.
 * Hardcoded per D-06, D-08: pass -> published, warn -> flagged, fail -> rejected.
 */
export function verdictToStatus(
  verdict: "pass" | "warn" | "fail",
): "published" | "flagged" | "rejected" {
  switch (verdict) {
    case "pass":
      return "published";
    case "warn":
      return "flagged";
    case "fail":
      return "rejected";
  }
}

// --- Audit Record Creation ---

/**
 * Atomically create an audit record and update the version status.
 * Uses db.batch() to ensure both operations succeed or fail together.
 *
 * When verdict is null (error case), the version is always rejected (fail-closed).
 * When status is "published", published_at is set to the current timestamp.
 *
 * Returns the generated `auditId` so callers (e.g. notification emitters)
 * can derive deterministic idempotency keys against the audit row that was
 * just written.
 */
export async function createAuditRecord(
  db: D1Database,
  params: CreateAuditParams,
): Promise<string> {
  const auditId = crypto.randomUUID();

  // Determine version status:
  // - explicit override wins (used by static-only scans to keep status='pending')
  // - else, use verdict mapping if available
  // - else, reject (legacy fail-closed for hard error paths)
  const versionStatus =
    params.versionStatusOverride ??
    (params.verdict !== null ? verdictToStatus(params.verdict) : "rejected");

  await db.batch([
    db
      .prepare(
        `INSERT INTO plugin_audits (
          id, plugin_version_id, status, model, prompt_tokens, completion_tokens,
          neurons_used, raw_response, verdict, risk_score, findings, public_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(
        auditId,
        params.versionId,
        params.status,
        params.model,
        params.promptTokens,
        params.completionTokens,
        params.neuronsUsed,
        params.rawResponse,
        params.verdict,
        params.riskScore,
        JSON.stringify(params.findings),
        params.publicNote ? 1 : 0,
      ),
    db
      .prepare(
        `UPDATE plugin_versions
         SET status = ?,
             published_at = CASE WHEN ? = 'published' THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE published_at END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`,
      )
      .bind(versionStatus, versionStatus, params.versionId),
  ]);

  return auditId;
}

// --- Error Rejection ---

/**
 * Reject a version after an unrecoverable error.
 * Creates an error audit record with no verdict and sets the version to rejected.
 * Used by the consumer for permanent failures that should not be retried.
 */
export async function rejectVersion(
  db: D1Database,
  versionId: string,
  errorMessage: string,
): Promise<void> {
  await createAuditRecord(db, {
    versionId,
    status: "error",
    model: "none",
    promptTokens: 0,
    completionTokens: 0,
    neuronsUsed: 0,
    rawResponse: errorMessage,
    verdict: null,
    riskScore: 0,
    findings: [],
  });
}

// --- Batch API Audit Lifecycle ---
//
// Batch audits have a longer lifecycle than sync audits:
//   1. Submit → createBatchAuditPending() writes a `status='pending'`
//      row carrying the Workers AI request_id. Version stays 'pending'.
//   2. Poll (every 2 min cron) → findPendingBatchAudits() returns all
//      rows eligible for a status check.
//   3. Each poll → incrementBatchPolls() bumps the counter for
//      circuit-breaker tracking.
//   4a. Still queued/running → leave the row alone, try again next cron.
//   4b. Complete → completeBatchAudit() updates the same row with
//      verdict, findings, token counts, and flips the version status.
//   4c. Terminal failure (batch API error, too many polls) →
//      failBatchAudit() flips row to 'error', version to 'rejected'.

export interface PendingBatchAudit {
  auditId: string;
  versionId: string;
  pluginId: string;
  version: string;
  model: string;
  batchRequestId: string;
  batchSubmittedAt: string;
  batchPolls: number;
}

export interface CreateBatchAuditPendingParams {
  versionId: string;
  model: string;
  batchRequestId: string;
}

/**
 * Create a pending audit row for a batch submission.
 *
 * Writes `status='pending'`, `verdict=NULL`, `batch_request_id=<id>` and
 * leaves token/neuron counts at 0 (we don't know the usage until the
 * batch completes). The version's own `status` is NOT changed — it
 * stays whatever it was (typically 'pending') until the poller calls
 * `completeBatchAudit()`. No `db.batch()` needed because there's no
 * atomic version update to coordinate.
 *
 * Returns the generated auditId so the caller can log it alongside the
 * Workers AI request_id for traceability.
 */
export async function createBatchAuditPending(
  db: D1Database,
  params: CreateBatchAuditPendingParams,
): Promise<string> {
  const auditId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO plugin_audits (
        id, plugin_version_id, status, model, prompt_tokens, completion_tokens,
        neurons_used, raw_response, verdict, risk_score, findings, public_note,
        batch_request_id, batch_submitted_at, batch_polls, created_at
      ) VALUES (?, ?, 'pending', ?, 0, 0, 0, ?, NULL, 0, '[]', 0, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(
      auditId,
      params.versionId,
      params.model,
      `Batch submitted, awaiting result. request_id=${params.batchRequestId}`,
      params.batchRequestId,
    )
    .run();
  return auditId;
}

/**
 * Find every audit row eligible for the batch-status poller.
 *
 * Selection criteria (matches the partial index in 0022_audit_batch.sql):
 *   - `status = 'pending'`
 *   - `batch_request_id IS NOT NULL`
 *
 * The query joins `plugin_versions` so the poller can write back to
 * the right version row without a second round trip.
 */
export async function findPendingBatchAudits(
  db: D1Database,
): Promise<PendingBatchAudit[]> {
  const { results } = await db
    .prepare(
      `SELECT
         pa.id            AS auditId,
         pa.plugin_version_id AS versionId,
         pv.plugin_id     AS pluginId,
         pv.version       AS version,
         pa.model         AS model,
         pa.batch_request_id AS batchRequestId,
         pa.batch_submitted_at AS batchSubmittedAt,
         pa.batch_polls   AS batchPolls
       FROM plugin_audits pa
       JOIN plugin_versions pv ON pa.plugin_version_id = pv.id
       WHERE pa.status = 'pending' AND pa.batch_request_id IS NOT NULL
       ORDER BY pa.batch_submitted_at ASC`,
    )
    .all<PendingBatchAudit>();
  return results;
}

/**
 * Increment the poll counter on a pending batch audit row.
 *
 * Used by the poller on every tick regardless of outcome. The count
 * feeds the circuit breaker (`failBatchAudit` is called once the row
 * exceeds a threshold — typically 60 polls = 2 hours at 2 min/cron).
 */
export async function incrementBatchPolls(
  db: D1Database,
  auditId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugin_audits SET batch_polls = batch_polls + 1 WHERE id = ?`,
    )
    .bind(auditId)
    .run();
}

export interface CompleteBatchAuditParams {
  auditId: string;
  versionId: string;
  promptTokens: number;
  completionTokens: number;
  neuronsUsed: number;
  rawResponse: string;
  verdict: "pass" | "warn" | "fail";
  riskScore: number;
  findings: MarketplaceAuditFinding[];
}

/**
 * Complete a batch audit row with the final Workers AI result.
 *
 * Atomically (db.batch) updates the existing `pending` audit row in
 * place — same auditId, same model string, same created_at — to
 * `status='complete'` with the verdict, token counts, and findings,
 * AND flips the version status via verdictToStatus(). Published_at
 * is set for the 'pass' → 'published' transition, matching the sync
 * audit path.
 */
export async function completeBatchAudit(
  db: D1Database,
  params: CompleteBatchAuditParams,
): Promise<void> {
  const versionStatus = verdictToStatus(params.verdict);
  await db.batch([
    db
      .prepare(
        `UPDATE plugin_audits SET
          status = 'complete',
          prompt_tokens = ?,
          completion_tokens = ?,
          neurons_used = ?,
          raw_response = ?,
          verdict = ?,
          risk_score = ?,
          findings = ?
         WHERE id = ?`,
      )
      .bind(
        params.promptTokens,
        params.completionTokens,
        params.neuronsUsed,
        params.rawResponse,
        params.verdict,
        params.riskScore,
        JSON.stringify(params.findings),
        params.auditId,
      ),
    db
      .prepare(
        `UPDATE plugin_versions
         SET status = ?,
             published_at = CASE WHEN ? = 'published' THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE published_at END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`,
      )
      .bind(versionStatus, versionStatus, params.versionId),
  ]);
}

/**
 * Mark a batch audit as failed terminally.
 *
 * Called when the poller hits a non-retryable batch API error, or the
 * circuit breaker trips (too many polls without result). Flips the
 * audit row to `status='error'` AND the version to `rejected` — same
 * fail-closed behaviour as the sync rejectVersion() path.
 */
export async function failBatchAudit(
  db: D1Database,
  params: {
    auditId: string;
    versionId: string;
    errorMessage: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE plugin_audits SET
          status = 'error',
          model = 'none',
          raw_response = ?,
          verdict = NULL,
          risk_score = 0,
          findings = '[]'
         WHERE id = ?`,
      )
      .bind(params.errorMessage, params.auditId),
    db
      .prepare(
        `UPDATE plugin_versions SET status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
      )
      .bind(params.versionId),
  ]);
}
