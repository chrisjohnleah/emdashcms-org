/**
 * CRUD for `notification_deliveries`.
 *
 * Most of the heavy lifting lives in `idempotency.ts`; this module is a
 * thin layer over those primitives with:
 *   - `insertDeliveryClaim` — re-export of `claimDelivery` under the name
 *     the dashboard settings page expects.
 *   - `markDeliveryStatus` — unified wrapper that routes to markSent /
 *     markFailed / a bespoke bounce UPDATE depending on the target status.
 *   - `listDeliveriesForAuthor` — per-author history with a HARD 50-row
 *     cap (Pitfall 8 in 12-RESEARCH.md; the settings page renders this
 *     list, so unbounded queries would blow up D1 read cost).
 *   - `getDeliveryByIdempotencyKey` — single-row lookup used by tests and
 *     by the bounce webhook to correlate provider ids.
 */

import {
  claimDelivery,
  markSent,
  markFailed,
} from "./idempotency";

/**
 * Re-export `claimDelivery` under the name the dashboard settings page
 * uses. Keeps call sites readable (`insertDeliveryClaim` reads better
 * than `claimDelivery` from the settings-page perspective).
 */
export { claimDelivery as insertDeliveryClaim } from "./idempotency";

/**
 * Terminal or retryable status values the consumer and webhook receiver
 * transition a delivery row into.
 */
export type DeliveryStatus = "sent" | "failed" | "bounced" | "queued";

export interface MarkDeliveryDetail {
  providerId?: string;
  reason?: string;
}

/**
 * Unified status transition helper. Routes to the appropriate low-level
 * primitive based on the target state:
 *
 *   - 'sent'    → markSent(providerId)
 *   - 'failed'  → markFailed(reason, transient=false)
 *   - 'queued'  → markFailed(reason, transient=true) — used when a
 *                 transient error caused a retry
 *   - 'bounced' → direct UPDATE writing bounced_reason + status
 *                 (called from the bounce webhook handler in 12-02)
 */
export async function markDeliveryStatus(
  db: D1Database,
  idempotencyKey: string,
  status: DeliveryStatus,
  detail: MarkDeliveryDetail = {},
): Promise<void> {
  if (status === "sent") {
    await markSent(db, idempotencyKey, detail.providerId ?? "");
    return;
  }
  if (status === "failed") {
    await markFailed(db, idempotencyKey, detail.reason ?? "", false);
    return;
  }
  if (status === "queued") {
    await markFailed(db, idempotencyKey, detail.reason ?? "", true);
    return;
  }
  // bounced
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'bounced',
           bounced_reason = ?,
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE idempotency_key = ?`,
    )
    .bind(detail.reason ?? "", idempotencyKey)
    .run();
}

// ---------------------------------------------------------------------------
// listDeliveriesForAuthor
// ---------------------------------------------------------------------------

export interface DeliveryHistoryRow {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  status: string;
  createdAt: string;
  lastAttemptAt: string;
  bouncedReason: string | null;
}

const MAX_HISTORY_ROWS = 50;

/**
 * Get this author's recent notification history for the settings page.
 *
 * The `LIMIT` is capped server-side at 50 rows regardless of caller
 * input — Pitfall 8 in 12-RESEARCH.md. 50 rows is enough for publisher
 * self-service debugging; anything deeper is an admin D1 query.
 */
export async function listDeliveriesForAuthor(
  db: D1Database,
  authorId: string,
  limit: number = MAX_HISTORY_ROWS,
): Promise<DeliveryHistoryRow[]> {
  const capped = Math.min(Math.max(1, limit), MAX_HISTORY_ROWS);
  const result = await db
    .prepare(
      `SELECT id, event_type, entity_type, entity_id, status,
              created_at, last_attempt_at, bounced_reason
       FROM notification_deliveries
       WHERE author_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(authorId, capped)
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    eventType: r.event_type as string,
    entityType: r.entity_type as string,
    entityId: (r.entity_id as string | null) ?? null,
    status: r.status as string,
    createdAt: r.created_at as string,
    lastAttemptAt: r.last_attempt_at as string,
    bouncedReason: (r.bounced_reason as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// getDeliveryByIdempotencyKey
// ---------------------------------------------------------------------------

export interface DeliveryLookup {
  id: string;
  status: string;
  providerId: string | null;
}

/**
 * Look up a single delivery row by idempotency key. Returns `null` when
 * no matching row exists (e.g. the bounce webhook received an event for
 * an email we don't know about).
 */
export async function getDeliveryByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<DeliveryLookup | null> {
  const row = await db
    .prepare(
      `SELECT id, status, provider_id
       FROM notification_deliveries
       WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<{
      id: string;
      status: string;
      provider_id: string | null;
    }>();
  if (!row) return null;
  return { id: row.id, status: row.status, providerId: row.provider_id };
}
