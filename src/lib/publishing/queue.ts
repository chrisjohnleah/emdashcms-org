/**
 * Audit queue helper for dispatching audit jobs.
 *
 * Wraps Queue.send() with typed AuditJob. The AuditJob payload is well
 * under the 128KB Queue message limit (typically <1KB).
 */
import type { AuditJob } from "../../types/marketplace";

/**
 * Send an audit job to the audit queue for async processing by the
 * queue consumer (implemented in Phase 5).
 */
export async function enqueueAuditJob(
  queue: Queue,
  job: AuditJob,
): Promise<void> {
  await queue.send(job);
}
