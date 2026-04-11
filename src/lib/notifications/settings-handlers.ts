/**
 * Form-POST handlers for the publisher notification settings page.
 *
 * These functions are extracted from `src/pages/dashboard/settings.astro`
 * so the business logic is testable without running the Astro page
 * pipeline (the vitest-pool-workers harness does not render Astro routes
 * end-to-end; see `test/worker-test-entry.ts`).
 *
 * Each handler accepts:
 *   - the D1 database binding
 *   - the current author id (already derived from the session — never
 *     accepted as a request parameter; T-19 mitigation)
 *   - a plain `FormData`-like record with allow-listed fields
 *
 * All handlers return a `BannerResult` describing what the settings page
 * should flash to the publisher. None of the handlers throw on user
 * error — they return an error banner instead. Genuine infrastructure
 * failures (D1 offline, network errors from Unosend on non-graceful
 * paths) are allowed to propagate so the Astro page's outer try/catch
 * renders a generic "Unexpected error" banner.
 *
 * Security notes:
 *   - `upsertPreferences` already strips unknown columns; the handler
 *     builds its own allow-list on top so only fields present in the
 *     form are written. There is NO path by which a caller can inject
 *     an `authorId` field from request data — every handler takes the
 *     session-resolved `authorId` as an argument.
 *   - Email override validation matches `resolveEffectiveEmail`: length,
 *     `@`, and CRLF rejection (T-03 SMTP header injection).
 *   - Test-send is rate-limited to once per 60 seconds per author via a
 *     cheap `notification_deliveries` lookup (T-22); the same row also
 *     acts as the idempotency claim for the send.
 */

import {
  getPreferencesForAuthor,
  upsertPreferences,
  resolveEffectiveEmail,
  type NotificationPreferences,
} from "./preference-queries";
import {
  insertDeliveryClaim,
  markDeliveryStatus,
} from "./delivery-queries";
import { deriveIdempotencyKey } from "./idempotency";
import {
  sendTransactional,
  UnosendTransientError,
  UnosendPermanentError,
} from "./unosend-client";
import {
  renderTestSend,
  FROM_ADDRESS,
  REPLY_TO,
} from "./templates";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BannerType = "success" | "error" | "warn";

export interface BannerResult {
  type: BannerType;
  message: string;
}

/**
 * Minimal shape we need from a `FormData` instance. Using a structural
 * type rather than the DOM lib interface lets tests pass plain objects.
 */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
  has(name: string): boolean;
}

/**
 * Tiny in-memory adapter so tests can pass a plain `{ field: value }`
 * object without constructing a real `FormData` instance.
 */
export function formDataFromRecord(
  record: Record<string, string | boolean | null | undefined>,
): FormLike {
  const present = new Set<string>();
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === false || value === null) continue;
    present.add(key);
    if (typeof value === "string") values.set(key, value);
    else values.set(key, "on"); // boolean true → HTML "on" convention
  }
  return {
    get: (name: string) => values.get(name) ?? null,
    has: (name: string) => present.has(name),
  };
}

// ---------------------------------------------------------------------------
// Allow-lists (T-19 mitigation)
// ---------------------------------------------------------------------------

/**
 * Boolean preference toggles. Order matters only for determinism; every
 * field in this list is a checkbox on the settings page.
 */
export const ALLOWED_TOGGLE_FIELDS = [
  "masterEnabled",
  "auditFailEnabled",
  "auditErrorEnabled",
  "auditWarnEnabled",
  "auditPassEnabled",
  "revokeVersionEnabled",
  "revokePluginEnabled",
  "reportFiledEnabled",
] as const satisfies ReadonlyArray<keyof NotificationPreferences>;

/**
 * Delivery-mode radio fields. Every non-'immediate' value that isn't
 * exactly 'daily_digest' is rejected silently — the default is
 * preserved by the `continue` in the loop below.
 */
export const ALLOWED_MODE_FIELDS = [
  "auditFailMode",
  "auditErrorMode",
  "auditWarnMode",
  "auditPassMode",
  "revokeVersionMode",
  "revokePluginMode",
  "reportFiledMode",
] as const satisfies ReadonlyArray<keyof NotificationPreferences>;

// ---------------------------------------------------------------------------
// handleSavePreferences
// ---------------------------------------------------------------------------

/**
 * Persist the preference form into `notification_preferences`.
 *
 * Only allow-listed toggle and mode fields are written. Any stray
 * `author_id` or SQL-shaped input on the form is silently discarded by
 * `upsertPreferences` (which itself has an internal allow-list) — the
 * double gate is intentional.
 */
export async function handleSavePreferences(
  db: D1Database,
  authorId: string,
  form: FormLike,
): Promise<BannerResult> {
  const updates: Partial<NotificationPreferences> = {};

  // Checkbox semantics: absent from the form means unchecked → false.
  // Every toggle is always written so the form can clear as well as set.
  for (const field of ALLOWED_TOGGLE_FIELDS) {
    (updates as Record<string, unknown>)[field] = form.has(field);
  }

  // Mode fields are only written when the value is a recognised enum.
  for (const field of ALLOWED_MODE_FIELDS) {
    const raw = form.get(field);
    if (raw === null) continue;
    const value = String(raw);
    if (value === "immediate" || value === "daily_digest") {
      (updates as Record<string, unknown>)[field] = value;
    }
  }

  await upsertPreferences(db, authorId, updates);
  return { type: "success", message: "Preferences saved." };
}

// ---------------------------------------------------------------------------
// handleSaveEmail
// ---------------------------------------------------------------------------

const EMAIL_MAX_LEN = 320;

/**
 * Validate an email override candidate using the same rules as
 * `resolveEffectiveEmail`.
 */
export function validateEmailOverride(candidate: string): string | null {
  if (candidate.length === 0) return "Email address cannot be empty.";
  if (candidate.length > EMAIL_MAX_LEN) return "Email address is too long.";
  if (!candidate.includes("@")) return "Email address must contain '@'.";
  if (candidate.includes("\r") || candidate.includes("\n")) {
    return "Email address contains invalid characters.";
  }
  return null;
}

/**
 * Persist a manual email override. On validation failure, returns an
 * error banner and does NOT touch the DB.
 */
export async function handleSaveEmail(
  db: D1Database,
  authorId: string,
  form: FormLike,
): Promise<BannerResult> {
  const raw = form.get("email_override");
  const candidate = raw === null ? "" : String(raw).trim();
  const error = validateEmailOverride(candidate);
  if (error) return { type: "error", message: error };

  await upsertPreferences(db, authorId, { emailOverride: candidate });
  return { type: "success", message: "Email override saved." };
}

// ---------------------------------------------------------------------------
// handleClearEmailOverride
// ---------------------------------------------------------------------------

/**
 * Clear a previously-set email override so future sends fall back to
 * the GitHub-pulled `authors.email`.
 */
export async function handleClearEmailOverride(
  db: D1Database,
  authorId: string,
): Promise<BannerResult> {
  await upsertPreferences(db, authorId, { emailOverride: null });
  return {
    type: "success",
    message: "Email override cleared — using GitHub-synced email.",
  };
}

// ---------------------------------------------------------------------------
// handleTestSend
// ---------------------------------------------------------------------------

export const TEST_SEND_COOLDOWN_SECONDS = 60;

const DASHBOARD_URL = "https://emdashcms.org/dashboard";

export interface TestSendDeps {
  /** Unosend API key — passed through rather than read from a closure so tests can override. */
  unosendApiKey: string;
}

/**
 * Send a test email via the real Unosend pipeline.
 *
 * The function is a synchronous send (no queueing) because the publisher
 * is staring at the settings page waiting for a banner — a queued
 * delivery would defeat the "is my email working right now?" semantics.
 * We still use the same `insertDeliveryClaim` → send → `markDeliveryStatus`
 * sequence as the queue consumer so the delivery shows up in the history
 * table and is idempotent against double clicks.
 *
 * Rate limit (T-22): a cheap SQL lookup on `notification_deliveries`
 * rejects the second call inside a 60-second window. The same table is
 * read by the history view, so no new columns or tables are needed.
 */
export async function handleTestSend(
  db: D1Database,
  authorId: string,
  deps: TestSendDeps,
): Promise<BannerResult> {
  // 1. Rate limit — cheap EXISTS query on the author's recent test_send rows.
  const recentRow = await db
    .prepare(
      `SELECT 1 AS found FROM notification_deliveries
       WHERE author_id = ? AND event_type = 'test_send'
         AND created_at > datetime('now', '-${TEST_SEND_COOLDOWN_SECONDS} seconds')
       LIMIT 1`,
    )
    .bind(authorId)
    .first<{ found: number }>();
  if (recentRow) {
    return {
      type: "error",
      message:
        "Test email already sent recently. Try again in a minute.",
    };
  }

  // 2. Load author + preferences to resolve the effective address.
  const authorRow = await db
    .prepare(
      "SELECT email, email_bounced_at FROM authors WHERE id = ?",
    )
    .bind(authorId)
    .first<{ email: string | null; email_bounced_at: string | null }>();
  if (!authorRow) {
    return { type: "error", message: "Author record not found." };
  }

  const prefs = await getPreferencesForAuthor(db, authorId);
  const effectiveEmail = resolveEffectiveEmail(
    {
      email: authorRow.email,
      emailBouncedAt: authorRow.email_bounced_at,
    },
    { emailOverride: prefs.emailOverride },
  );
  if (!effectiveEmail) {
    return {
      type: "error",
      message:
        "No deliverable email address. Add a manual override below or reconnect your GitHub email.",
    };
  }

  // 3. Claim a delivery row (same pattern as the queue consumer).
  const testEventId = crypto.randomUUID();
  const idempotencyKey = await deriveIdempotencyKey(testEventId, authorId);
  const claimed = await insertDeliveryClaim(db, {
    idempotencyKey,
    authorId,
    eventType: "test_send",
    entityType: "none",
    entityId: null,
    deliveryMode: "immediate",
  });
  if (!claimed) {
    // Double-POST in the same millisecond. Surface as rate-limit.
    return {
      type: "error",
      message:
        "Test email already sent recently. Try again in a minute.",
    };
  }

  // 4. Render + send via the real Unosend pipeline.
  try {
    const rendered = renderTestSend({ dashboardUrl: DASHBOARD_URL });
    const response = await sendTransactional({
      apiKey: deps.unosendApiKey,
      from: FROM_ADDRESS,
      to: effectiveEmail,
      replyTo: REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: [{ name: "event_type", value: "test_send" }],
    });
    await markDeliveryStatus(db, idempotencyKey, "sent", {
      providerId: response.id,
    });
    return {
      type: "success",
      message: `Test email sent to ${effectiveEmail}.`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof UnosendTransientError) {
      await markDeliveryStatus(db, idempotencyKey, "queued", {
        reason,
      });
      return {
        type: "error",
        message: `Test send failed transiently: ${reason}. Retry in a minute.`,
      };
    }
    if (err instanceof UnosendPermanentError) {
      await markDeliveryStatus(db, idempotencyKey, "failed", {
        reason,
      });
      return { type: "error", message: `Test send failed: ${reason}` };
    }
    // Unexpected error: still mark the claim as failed so retries work.
    await markDeliveryStatus(db, idempotencyKey, "failed", { reason });
    return { type: "error", message: `Test send failed: ${reason}` };
  }
}

// ---------------------------------------------------------------------------
// getAuthorBounceState (used by BaseLayout global banner)
// ---------------------------------------------------------------------------

/**
 * Status flags for the global dashboard banners — fetched in one round
 * trip so the layout doesn't pay for two SELECTs per page load.
 *
 * `missingEmail` is true when the author has no deliverable address on
 * file at all (e.g. they signed up during a deploy window where the
 * `user:email` OAuth scope hadn't shipped yet). Renders a "re-link
 * GitHub" prompt so they can grant the scope without waiting for an
 * out-of-band fix.
 *
 * `bounced` is true when an existing address has hard-bounced and the
 * author needs to update the override.
 *
 * Both signals come from the same row, so a single SELECT covers them.
 */
export async function getAuthorEmailStatus(
  db: D1Database,
  authorId: string,
): Promise<{ missingEmail: boolean; bounced: boolean }> {
  const row = await db
    .prepare("SELECT email, email_bounced_at FROM authors WHERE id = ?")
    .bind(authorId)
    .first<{ email: string | null; email_bounced_at: string | null }>();
  if (!row) return { missingEmail: false, bounced: false };
  return {
    missingEmail: !row.email,
    bounced: !!row.email_bounced_at,
  };
}

/**
 * Cheap single-column lookup for the global bounce banner. Returns
 * `true` when the author's email has hard-bounced and they should see
 * the warning banner on every authenticated dashboard page.
 *
 * Kept for callers that only need the bounce signal; prefer
 * `getAuthorEmailStatus` when both flags are needed in one trip.
 */
export async function hasAuthorBounced(
  db: D1Database,
  authorId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT email_bounced_at FROM authors WHERE id = ?")
    .bind(authorId)
    .first<{ email_bounced_at: string | null }>();
  return !!row?.email_bounced_at;
}
