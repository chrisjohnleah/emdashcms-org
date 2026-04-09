/**
 * NOTIF_QUEUE producer helper.
 *
 * Thin wrapper over `Queue.send()` that pins the payload type to
 * `NotificationJob`. Kept in its own module (rather than bolted onto
 * `src/lib/publishing/queue.ts`) so the audit and notification pipelines
 * stay separately owned — single responsibility per helper, matching the
 * pattern established by `enqueueAuditJob`.
 *
 * NotificationJob payloads are well under the 128KB queue message limit
 * (typical size is <1KB — event metadata + a small `payload` record).
 */

import type { NotificationJob } from "../../types/marketplace";

/**
 * Send a notification job to NOTIF_QUEUE for async delivery by the
 * queue consumer (implemented in Plan 12-02).
 */
export async function enqueueNotificationJob(
  queue: Queue,
  job: NotificationJob,
): Promise<void> {
  await queue.send(job);
}
