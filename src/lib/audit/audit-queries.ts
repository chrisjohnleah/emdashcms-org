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
  versionStatusOverride?: "pending" | "published" | "flagged" | "rejected";
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
 */
export async function createAuditRecord(
  db: D1Database,
  params: CreateAuditParams,
): Promise<void> {
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
          neurons_used, raw_response, verdict, risk_score, findings, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
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
