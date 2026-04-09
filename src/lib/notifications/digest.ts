/**
 * Daily digest aggregator — triggered by Cron `5 9 * * *` (09:05 UTC).
 *
 * Picks up `notification_deliveries` rows with `delivery_mode='daily_digest'`
 * and `status='queued'`, groups them by author, renders one aggregated
 * email per author, sends via Unosend, and flips the row statuses.
 *
 * The cron IS the retry loop for digest mode — transient send errors
 * leave rows as `queued` for the next day's run; permanent errors mark
 * rows `failed`; authors with bounced or missing emails have all their
 * queued digest rows marked `skipped`.
 *
 * This handler runs OUT-OF-BAND from NOTIF_QUEUE. The queue consumer
 * (Plan 12-02) is the path for `immediate`-mode events; the digest
 * handler never touches immediate rows — its WHERE clause is filtered
 * to `delivery_mode = 'daily_digest'`.
 *
 * Safety cap: `LIMIT 1000` per run. If an unusually busy day produces
 * more than 1000 pending digest rows, the overflow is picked up by the
 * next day's cron. The current free-tier assumption is "hundreds per
 * day at most" so the cap is a defence against runaway volume rather
 * than a routine concern.
 */

import {
  getPreferencesForAuthor,
  resolveEffectiveEmail,
} from "./preference-queries";
import {
  renderDigest,
  FROM_ADDRESS,
  REPLY_TO,
  type DigestEvent,
} from "./templates";
import {
  sendTransactional,
  UnosendTransientError,
  UnosendPermanentError,
} from "./unosend-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DigestRow {
  id: string;
  idempotency_key: string;
  author_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
}

const DIGEST_ROW_LIMIT = 1000;
const DASHBOARD_URL = "https://emdashcms.org/dashboard";

// ---------------------------------------------------------------------------
// runDailyDigest
// ---------------------------------------------------------------------------

export async function runDailyDigest(env: Env): Promise<void> {
  const result = await env.DB
    .prepare(
      `SELECT id, idempotency_key, author_id, event_type, entity_type, entity_id, created_at
       FROM notification_deliveries
       WHERE delivery_mode = 'daily_digest' AND status = 'queued'
       ORDER BY author_id, created_at ASC
       LIMIT ?`,
    )
    .bind(DIGEST_ROW_LIMIT)
    .all();
  const rows = result.results as unknown as DigestRow[];

  if (rows.length === 0) {
    console.log("[digest] no pending digest rows");
    return;
  }

  // Group by author_id in a stable Map so log lines are deterministic.
  const byAuthor = new Map<string, DigestRow[]>();
  for (const row of rows) {
    const bucket = byAuthor.get(row.author_id) ?? [];
    bucket.push(row);
    byAuthor.set(row.author_id, bucket);
  }

  for (const [authorId, authorRows] of byAuthor) {
    try {
      await processAuthorDigest(env, authorId, authorRows);
    } catch (err) {
      // Defensive outer catch — per-author failures must not block other
      // authors. The inner function already handles the known error
      // shapes; this guards against anything unexpected.
      console.error(`[digest] outer error for author=${authorId}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// processAuthorDigest
// ---------------------------------------------------------------------------

async function processAuthorDigest(
  env: Env,
  authorId: string,
  authorRows: DigestRow[],
): Promise<void> {
  // Load the author row for email + bounce flag.
  const authorRow = await env.DB
    .prepare("SELECT email, email_bounced_at FROM authors WHERE id = ?")
    .bind(authorId)
    .first<{ email: string | null; email_bounced_at: string | null }>();
  if (!authorRow) {
    await markRows(env.DB, authorRows, "skipped", "author row missing");
    console.log(
      `[digest] author=${authorId} events=${authorRows.length} status=skipped reason=missing_author`,
    );
    return;
  }

  const prefs = await getPreferencesForAuthor(env.DB, authorId);
  const effectiveEmail = resolveEffectiveEmail(
    {
      email: authorRow.email,
      emailBouncedAt: authorRow.email_bounced_at,
    },
    { emailOverride: prefs.emailOverride },
  );
  if (!effectiveEmail) {
    await markRows(env.DB, authorRows, "skipped", "no deliverable email");
    console.log(
      `[digest] author=${authorId} events=${authorRows.length} status=skipped reason=no_email`,
    );
    return;
  }

  // Build the event summaries. Entity names are looked up once per
  // row — volume is capped at DIGEST_ROW_LIMIT so this is bounded.
  const events = await buildDigestEvents(env, authorRows);

  const rendered = renderDigest({
    events,
    dashboardUrl: DASHBOARD_URL,
  });

  try {
    const response = await sendTransactional({
      apiKey: (env as unknown as { UNOSEND_API_KEY: string }).UNOSEND_API_KEY,
      from: FROM_ADDRESS,
      to: effectiveEmail,
      replyTo: REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: [{ name: "event_type", value: "digest" }],
    });
    await markRows(env.DB, authorRows, "sent", null, response.id);
    console.log(
      `[digest] author=${authorId} events=${authorRows.length} status=sent provider_id=${response.id}`,
    );
  } catch (err) {
    if (err instanceof UnosendTransientError) {
      // Leave rows queued for the next cron run. The consumer-style
      // retry contract applies: status stays 'queued' so the same row
      // will be re-selected tomorrow at 09:05 UTC.
      console.warn(
        `[digest] transient error for author=${authorId}, leaving queued: ${err.message}`,
      );
      await bumpAttemptCounts(env.DB, authorRows, err.message);
      return;
    }
    if (err instanceof UnosendPermanentError) {
      await markRows(env.DB, authorRows, "failed", err.message);
      console.error(
        `[digest] permanent error for author=${authorId}: ${err.message}`,
      );
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    await markRows(env.DB, authorRows, "failed", reason);
    console.error(
      `[digest] unexpected error for author=${authorId}: ${reason}`,
    );
  }
}

// ---------------------------------------------------------------------------
// buildDigestEvents
// ---------------------------------------------------------------------------

async function buildDigestEvents(
  env: Env,
  rows: DigestRow[],
): Promise<DigestEvent[]> {
  const events: DigestEvent[] = [];
  // Cache entity-name lookups inside a single author's digest — a plugin
  // with 5 events in a day shouldn't produce 5 identical SELECTs.
  const nameCache = new Map<string, string>();

  for (const row of rows) {
    let entityName = row.entity_id ?? "unknown";

    if (row.entity_id && (row.entity_type === "plugin" || row.entity_type === "theme")) {
      const cacheKey = `${row.entity_type}:${row.entity_id}`;
      const cached = nameCache.get(cacheKey);
      if (cached !== undefined) {
        entityName = cached;
      } else {
        const table = row.entity_type === "plugin" ? "plugins" : "themes";
        const nameRow = await env.DB
          .prepare(`SELECT name FROM ${table} WHERE id = ?`)
          .bind(row.entity_id)
          .first<{ name: string }>();
        if (nameRow?.name) {
          entityName = nameRow.name;
          nameCache.set(cacheKey, nameRow.name);
        } else {
          nameCache.set(cacheKey, entityName);
        }
      }
    }

    events.push({
      eventType: row.event_type,
      entityName,
      summary: summariseEvent(row),
      timestamp: row.created_at,
    });
  }

  return events;
}

/**
 * Short human-readable summary line for each event in the digest body.
 * Kept intentionally terse — the digest email is a signal, the dashboard
 * is the detail view.
 */
function summariseEvent(row: DigestRow): string {
  switch (row.event_type) {
    case "audit_fail":
      return "Automated audit rejected a version.";
    case "audit_error":
      return "Automated audit could not complete.";
    case "audit_warn":
      return "Automated audit flagged a version with a caution.";
    case "audit_pass":
      return "Automated audit returned a clean pass.";
    case "revoke_version":
      return "A version was revoked.";
    case "revoke_plugin":
      return "The listing was revoked.";
    case "report_filed":
      return "A report was filed against this listing.";
    default:
      return row.event_type;
  }
}

// ---------------------------------------------------------------------------
// Row status helpers
// ---------------------------------------------------------------------------

/**
 * Batch-update every row in the array to the same terminal status.
 *
 * Uses an IN clause with positional placeholders rather than D1's
 * `batch()` API — one round trip instead of N. The number of
 * placeholders is bounded by `DIGEST_ROW_LIMIT`, so the generated SQL
 * string is always well within D1's statement size cap.
 */
async function markRows(
  db: D1Database,
  rows: DigestRow[],
  status: "sent" | "skipped" | "failed",
  reason: string | null,
  providerId: string | null = null,
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = rows.map(() => "?").join(",");
  const bindings: (string | number | null)[] = [status, reason, providerId];
  for (const r of rows) bindings.push(r.idempotency_key);
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = ?,
           bounced_reason = ?,
           provider_id = COALESCE(?, provider_id),
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           attempt_count = attempt_count + 1
       WHERE idempotency_key IN (${placeholders})`,
    )
    .bind(...bindings)
    .run();
}

/**
 * Bump `attempt_count` + record the transient failure reason without
 * transitioning the row out of `queued`. Used when the digest send
 * failed transiently and we want the same rows to be retried on the
 * next cron run.
 */
async function bumpAttemptCounts(
  db: D1Database,
  rows: DigestRow[],
  reason: string,
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = rows.map(() => "?").join(",");
  const bindings: (string | null)[] = [reason];
  for (const r of rows) bindings.push(r.idempotency_key);
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET bounced_reason = ?,
           attempt_count = attempt_count + 1,
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE idempotency_key IN (${placeholders})`,
    )
    .bind(...bindings)
    .run();
}
