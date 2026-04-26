/**
 * NOTIF_QUEUE consumer.
 *
 * The state machine that turns enqueued NotificationJob payloads into
 * Unosend transactional sends, with at-most-once semantics and queue
 * retry classification.
 *
 * Per-job ordering (Pitfall 1 in 12-RESEARCH.md):
 *   1. Resolve recipient row from D1 (skip if missing).
 *   2. Load preferences; skip if the event is disabled or the master
 *      toggle is off.
 *   3. Resolve effective email; skip if no usable address (bounce flag
 *      set, or no email on file).
 *   4. claimDelivery — INSERT OR IGNORE on the idempotency key. If
 *      another worker already claimed it, ack without sending.
 *   5. Render the email body via templates.
 *   6. sendTransactional — POST to Unosend.
 *   7. markSent on success; markFailed on UnosendPermanentError; rethrow
 *      UnosendTransientError so the batch loop can call message.retry().
 *
 * Daily-digest events (`deliveryMode === 'daily_digest'`) claim a
 * delivery row but do NOT send — the digest cron handler in 12-03 picks
 * them up and rolls them into a single send.
 *
 * Retry classification (12-RESEARCH.md Pattern 4):
 *   - UnosendTransientError → message.retry({delaySeconds}) using
 *     BACKOFF_SCHEDULE_S based on attempts. After max_retries (3, set
 *     in wrangler.jsonc) the message lands in
 *     `emdashcms-notifications-dlq`.
 *   - UnosendPermanentError or any other thrown error → markFailed +
 *     ack. The DLQ is reserved for transient failure exhaustion.
 */

import {
  sendTransactional,
  UnosendTransientError,
  UnosendPermanentError,
} from "./unosend-client";
import {
  claimDelivery,
  markSent,
  markFailed,
} from "./idempotency";
import {
  getPreferencesForAuthor,
  isEventEnabled,
  resolveEffectiveEmail,
} from "./preference-queries";
import { markDeliveryStatus } from "./delivery-queries";
import {
  FROM_ADDRESS,
  REPLY_TO,
  renderAuditFail,
  renderAuditError,
  renderAuditWarn,
  renderAuditPass,
  renderRevokeVersion,
  renderRevokePlugin,
  renderReportFiled,
  renderTestSend,
  type RenderedEmail,
} from "./templates";
import type { NotificationJob } from "../../types/marketplace";

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

/**
 * Delay (seconds) the consumer asks the queue to wait before redelivering
 * a transient-failed notification. Index = current attempt count.
 *
 * 30s → 2min → 10min covers most rate-limit windows on Unosend without
 * keeping the message stuck for hours. After three attempts the message
 * is dead-lettered to `emdashcms-notifications-dlq` (max_retries: 3).
 */
export const BACKOFF_SCHEDULE_S = [30, 120, 600];

function backoffDelay(attempts: number): number {
  const idx = Math.min(Math.max(0, attempts - 1), BACKOFF_SCHEDULE_S.length - 1);
  return BACKOFF_SCHEDULE_S[idx];
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export interface NotificationBindings {
  db: D1Database;
  unosendApiKey: string;
}

// ---------------------------------------------------------------------------
// Author lookup
// ---------------------------------------------------------------------------

interface AuthorRow {
  id: string;
  email: string | null;
  email_bounced_at: string | null;
}

async function loadAuthor(
  db: D1Database,
  authorId: string,
): Promise<AuthorRow | null> {
  return db
    .prepare("SELECT id, email, email_bounced_at FROM authors WHERE id = ?")
    .bind(authorId)
    .first<AuthorRow>();
}

// ---------------------------------------------------------------------------
// Template dispatch
// ---------------------------------------------------------------------------

const DASHBOARD_BASE = "https://emdashcms.org/dashboard";

function renderForJob(job: NotificationJob): RenderedEmail {
  const payload = job.payload as Record<string, unknown>;
  const dashboardUrl = `${DASHBOARD_BASE}/settings/notifications`;

  switch (job.eventType) {
    case "audit_fail": {
      // Build a per-plugin upload URL so the email's primary CTA goes
      // directly to the upload-new-version page on this plugin — the
      // intended remediation path. Falls back to the generic dashboard
      // URL only if the entityId is somehow missing from the job.
      const uploadUrl = job.entityId
        ? `${DASHBOARD_BASE}/plugins/${encodeURIComponent(job.entityId)}/upload`
        : dashboardUrl;
      const rawFindings = Array.isArray(payload.topFindings)
        ? (payload.topFindings as unknown[])
        : [];
      const topFindings = rawFindings
        .filter(
          (f): f is { severity: unknown; title: unknown } =>
            typeof f === "object" && f !== null,
        )
        .map((f) => ({
          severity: String(f.severity ?? "info"),
          title: String(f.title ?? "Untitled finding"),
        }));
      return renderAuditFail({
        pluginName: String(payload.pluginName ?? ""),
        version: String(payload.version ?? ""),
        verdict: "fail",
        riskScore: Number(payload.riskScore ?? 0),
        findingCount: Number(payload.findingCount ?? 0),
        dashboardUrl,
        uploadUrl,
        topFindings,
      });
    }
    case "audit_error":
      return renderAuditError({
        pluginName: String(payload.pluginName ?? ""),
        version: String(payload.version ?? ""),
        errorMessage: String(payload.errorMessage ?? "Unknown error"),
        dashboardUrl,
      });
    case "audit_warn":
      return renderAuditWarn({
        pluginName: String(payload.pluginName ?? ""),
        version: String(payload.version ?? ""),
        verdict: "warn",
        riskScore: Number(payload.riskScore ?? 0),
        findingCount: Number(payload.findingCount ?? 0),
        dashboardUrl,
      });
    case "audit_pass":
      return renderAuditPass({
        pluginName: String(payload.pluginName ?? ""),
        version: String(payload.version ?? ""),
        riskScore: Number(payload.riskScore ?? 0),
        dashboardUrl,
      });
    case "revoke_version":
      return renderRevokeVersion({
        pluginName: String(payload.entityName ?? ""),
        version: String(payload.version ?? ""),
        reason: String(payload.reason ?? ""),
        publicNote:
          typeof payload.publicNote === "string"
            ? payload.publicNote
            : null,
        dashboardUrl,
      });
    case "revoke_plugin":
      return renderRevokePlugin({
        pluginName: String(payload.entityName ?? ""),
        reason: String(payload.reason ?? ""),
        publicNote:
          typeof payload.publicNote === "string"
            ? payload.publicNote
            : null,
        dashboardUrl,
      });
    case "report_filed":
      return renderReportFiled({
        entityType:
          payload.entityType === "theme" ? "theme" : "plugin",
        entityName: String(payload.entityName ?? ""),
        category: String(payload.category ?? "other"),
        descriptionExcerpt: String(payload.descriptionExcerpt ?? ""),
        dashboardUrl,
      });
    case "test_send":
      return renderTestSend({ dashboardUrl });
    case "digest":
      // Digest is rendered by the cron handler in 12-03, not by the
      // per-event consumer. Reaching here is a wiring bug.
      throw new Error(
        "[notifications] consumer received a 'digest' event — digest assembly is the cron handler's job",
      );
    default: {
      const _exhaustive: never = job.eventType;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// processNotificationJob — single job state machine
// ---------------------------------------------------------------------------

/**
 * Process a single NotificationJob.
 *
 * Throws `UnosendTransientError` so the batch loop can issue a
 * `message.retry({delaySeconds})`. All other thrown errors are
 * unrecoverable and the batch loop should ack the message.
 *
 * Returns `void` on every "happy" path including:
 *   - successful send (status='sent')
 *   - skipped due to disabled preferences (status='skipped')
 *   - skipped due to no deliverable email (status='skipped')
 *   - skipped due to duplicate idempotency claim (no row mutation)
 *   - daily-digest queueing (status='queued', delivery_mode='daily_digest')
 *   - permanent Unosend error (status='failed')
 */
export async function processNotificationJob(
  job: NotificationJob,
  bindings: NotificationBindings,
): Promise<void> {
  const { db } = bindings;
  const idempotencyKey = String(
    (job.payload as Record<string, unknown>).idempotencyKey ?? "",
  );

  if (!idempotencyKey) {
    console.error(
      `[notifications] job missing idempotencyKey — eventId=${job.eventId} recipient=${job.recipientAuthorId}`,
    );
    return;
  }

  // 1. Recipient row
  const author = await loadAuthor(db, job.recipientAuthorId);
  if (!author) {
    await skipDelivery(db, job, idempotencyKey, "recipient not found");
    return;
  }

  // 2. Preferences
  const prefs = await getPreferencesForAuthor(db, author.id);
  if (!isEventEnabled(prefs, job.eventType)) {
    await skipDelivery(db, job, idempotencyKey, "disabled in preferences");
    return;
  }

  // 3. Effective email
  const effectiveEmail = resolveEffectiveEmail(
    { email: author.email, emailBouncedAt: author.email_bounced_at },
    { emailOverride: prefs.emailOverride },
  );
  if (!effectiveEmail) {
    await skipDelivery(db, job, idempotencyKey, "no deliverable email");
    return;
  }

  // 4. Daily digest path: claim a queued row and let the cron handler
  //    pick it up. Do NOT call Unosend.
  if (job.deliveryMode === "daily_digest") {
    await claimDelivery(db, {
      idempotencyKey,
      authorId: author.id,
      eventType: job.eventType,
      entityType: job.entityType,
      entityId: job.entityId,
      deliveryMode: "daily_digest",
    });
    return;
  }

  // 5. Claim the delivery row first — INSERT OR IGNORE on the unique
  //    idempotency key. If another worker has already claimed this slot,
  //    ack without sending.
  const claimed = await claimDelivery(db, {
    idempotencyKey,
    authorId: author.id,
    eventType: job.eventType,
    entityType: job.entityType,
    entityId: job.entityId,
    deliveryMode: "immediate",
  });
  if (!claimed) {
    console.log(
      `[notifications] duplicate delivery skipped key=${idempotencyKey.slice(0, 12)}…`,
    );
    return;
  }

  // 6. Render the email body
  let rendered: RenderedEmail;
  try {
    rendered = renderForJob(job);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markFailed(db, idempotencyKey, `render failed: ${reason}`, false);
    console.error(`[notifications] render failed:`, err);
    return;
  }

  // 7. Call Unosend
  try {
    const response = await sendTransactional({
      apiKey: bindings.unosendApiKey,
      from: FROM_ADDRESS,
      to: effectiveEmail,
      replyTo: REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: [
        { name: "event_type", value: job.eventType },
        { name: "entity_id", value: job.entityId ?? "none" },
      ],
    });
    await markSent(db, idempotencyKey, response.id);
  } catch (err) {
    if (err instanceof UnosendTransientError) {
      // Mark queued so the next attempt re-reads the row, then rethrow
      // so the batch loop can call message.retry().
      await markFailed(db, idempotencyKey, err.message, true);
      throw err;
    }
    if (err instanceof UnosendPermanentError) {
      await markFailed(db, idempotencyKey, err.message, false);
      return;
    }
    // Unknown error — treat as permanent so we don't lose visibility in
    // the DLQ for non-transient bugs.
    const reason = err instanceof Error ? err.message : String(err);
    await markFailed(db, idempotencyKey, `unexpected: ${reason}`, false);
    console.error(`[notifications] unexpected send error:`, err);
  }
}

/**
 * Helper: write a 'skipped' delivery row when the consumer chooses not
 * to send (preferences off, no email, recipient missing). Uses
 * `claimDelivery` first so the row exists, then transitions it to
 * 'failed' with a clear reason — keeping the dashboard delivery history
 * honest about why no email went out.
 *
 * Note: status='skipped' isn't a first-class state in `markDeliveryStatus`,
 * but the dashboard renders any non-'sent' status with the bounced_reason
 * column, so writing 'failed' with the skip reason is the correct shape.
 */
async function skipDelivery(
  db: D1Database,
  job: NotificationJob,
  idempotencyKey: string,
  reason: string,
): Promise<void> {
  // Log every skip — silent skips mask configuration drift (the
  // canonical example: an author whose row has email=NULL will
  // suppress every audit notification with no other trace).
  console.warn(
    `[notifications] skipped eventType=${job.eventType} recipient=${job.recipientAuthorId} reason="${reason}"`,
  );
  const claimed = await claimDelivery(db, {
    idempotencyKey,
    authorId: job.recipientAuthorId,
    eventType: job.eventType,
    entityType: job.entityType,
    entityId: job.entityId,
    deliveryMode: job.deliveryMode,
  });
  if (claimed) {
    await markDeliveryStatus(db, idempotencyKey, "failed", { reason });
  }
}

// ---------------------------------------------------------------------------
// processNotificationBatch — queue handler entry point
// ---------------------------------------------------------------------------

interface BatchMessage {
  body: NotificationJob;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

interface NotificationMessageBatch {
  queue: string;
  messages: BatchMessage[];
}

export async function processNotificationBatch(
  batch: NotificationMessageBatch,
  bindings: NotificationBindings,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await processNotificationJob(job, bindings);
      message.ack();
    } catch (err) {
      if (err instanceof UnosendTransientError) {
        const delaySeconds = backoffDelay(message.attempts);
        console.warn(
          `[notifications] transient error eventType=${job.eventType} recipient=${job.recipientAuthorId} attempts=${message.attempts}: ${err.message} — retrying in ${delaySeconds}s`,
        );
        message.retry({ delaySeconds });
      } else {
        // Unrecoverable — already logged inside processNotificationJob.
        console.error(
          `[notifications] permanent failure eventType=${job.eventType} recipient=${job.recipientAuthorId}:`,
          err,
        );
        message.ack();
      }
    }
  }
}
