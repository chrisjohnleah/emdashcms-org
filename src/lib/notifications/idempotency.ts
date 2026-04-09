/**
 * Idempotency primitives for the notification pipeline.
 *
 * Cloudflare Queues is at-least-once: the same message may be delivered
 * more than once. We de-duplicate by deriving a deterministic key from
 * (eventId, recipientAuthorId), attempting `INSERT OR IGNORE` on the
 * `notification_deliveries.idempotency_key` UNIQUE column, and only
 * calling Unosend when the insert reported one row change.
 *
 * Critical ordering (Pitfall 1 in 12-RESEARCH.md):
 *   1. INSERT OR IGNORE (claim the delivery row atomically)
 *   2. Call Unosend
 *   3. UPDATE the row to status='sent' (or 'failed'/'queued' on error)
 *
 * Insert-first is safer than send-first: the worst case is "row shows
 * sent but the email never went out" (bounded by max_retries and
 * observable via DLQ), never "publisher receives the same email twice".
 */

/**
 * SHA-256 hex digest of `${eventId}:${recipientAuthorId}`. Stable across
 * queue redeliveries so the second attempt's `INSERT OR IGNORE` no-ops.
 */
export async function deriveIdempotencyKey(
  eventId: string,
  recipientAuthorId: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${eventId}:${recipientAuthorId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ClaimDeliveryParams {
  idempotencyKey: string;
  authorId: string;
  /** `NotificationEventType` — widened to string to avoid a type-level import cycle. */
  eventType: string;
  entityType: "plugin" | "theme" | "none";
  entityId: string | null;
  deliveryMode: "immediate" | "daily_digest";
}

/**
 * Attempt to claim a delivery row. Returns `true` when this call was
 * the first to insert (meta.changes === 1); `false` when a prior
 * attempt already claimed the same idempotency key.
 *
 * Callers treat `false` as "another worker is handling this delivery —
 * ack the queue message without sending".
 */
export async function claimDelivery(
  db: D1Database,
  params: ClaimDeliveryParams,
): Promise<boolean> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO notification_deliveries
        (id, idempotency_key, author_id, event_type, entity_type, entity_id,
         delivery_mode, status, attempt_count, created_at, last_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(
      id,
      params.idempotencyKey,
      params.authorId,
      params.eventType,
      params.entityType,
      params.entityId,
      params.deliveryMode,
    )
    .run();

  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Mark a claimed delivery as sent after Unosend returned a 2xx response.
 * Records the provider id (for correlation with bounce webhooks) and
 * bumps `attempt_count`.
 */
export async function markSent(
  db: D1Database,
  idempotencyKey: string,
  providerId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'sent',
           provider_id = ?,
           attempt_count = attempt_count + 1,
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE idempotency_key = ?`,
    )
    .bind(providerId, idempotencyKey)
    .run();
}

/**
 * Mark a claimed delivery as failed.
 *
 * - `transient=true`  → status stays `'queued'` so the next queue
 *   retry re-reads the row (no double-send: the `INSERT OR IGNORE`
 *   is idempotent on the key, and the consumer treats an existing
 *   row as "take over and complete the send").
 * - `transient=false` → status moves to `'failed'` and no further
 *   retries happen. The DLQ is responsible for visibility.
 */
export async function markFailed(
  db: D1Database,
  idempotencyKey: string,
  reason: string,
  transient: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = ?,
           bounced_reason = ?,
           attempt_count = attempt_count + 1,
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE idempotency_key = ?`,
    )
    .bind(transient ? "queued" : "failed", reason, idempotencyKey)
    .run();
}
