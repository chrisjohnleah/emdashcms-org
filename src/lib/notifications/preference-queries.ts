/**
 * CRUD for `notification_preferences`.
 *
 * Design choices (CONTEXT.md D-08, D-22, D-24, D-32):
 *   - Storage is discrete-column per event type, NOT a JSON blob. Lets
 *     the daily digest query use indexed WHERE clauses instead of
 *     json_extract.
 *   - The preference row is created lazily on first read (INSERT OR
 *     IGNORE + re-SELECT) so the migration doesn't have to backfill
 *     every existing author.
 *   - `upsertPreferences` uses a hard-coded allow-list of updatable
 *     columns — any unknown field on the patch object is silently
 *     dropped (T-02 mitigation against SQL injection via column name).
 *   - `resolveEffectiveEmail` is the single source of truth for "what
 *     address do we send to?" — it consults the bounce flag, the
 *     manual override, and finally the GitHub-pulled address.
 */

import type {
  NotificationEventType,
  NotificationDeliveryMode,
} from "../../types/marketplace";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationPreferences {
  authorId: string;
  masterEnabled: boolean;

  auditFailEnabled: boolean;
  auditFailMode: NotificationDeliveryMode;
  auditErrorEnabled: boolean;
  auditErrorMode: NotificationDeliveryMode;
  auditWarnEnabled: boolean;
  auditWarnMode: NotificationDeliveryMode;
  auditPassEnabled: boolean;
  auditPassMode: NotificationDeliveryMode;
  revokeVersionEnabled: boolean;
  revokeVersionMode: NotificationDeliveryMode;
  revokePluginEnabled: boolean;
  revokePluginMode: NotificationDeliveryMode;
  reportFiledEnabled: boolean;
  reportFiledMode: NotificationDeliveryMode;

  emailOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * D-08 defaults. Opt-in events (audit_pass, report_filed) are off by
 * default because they are either chatty (pass on every version) or a
 * spam vector (report filed). Everything else is on.
 */
export const DEFAULT_PREFERENCES: Omit<
  NotificationPreferences,
  "authorId" | "createdAt" | "updatedAt"
> = {
  masterEnabled: true,
  auditFailEnabled: true,
  auditFailMode: "immediate",
  auditErrorEnabled: true,
  auditErrorMode: "immediate",
  auditWarnEnabled: true,
  auditWarnMode: "immediate",
  auditPassEnabled: false,
  auditPassMode: "immediate",
  revokeVersionEnabled: true,
  revokeVersionMode: "immediate",
  revokePluginEnabled: true,
  revokePluginMode: "immediate",
  reportFiledEnabled: false,
  reportFiledMode: "immediate",
  emailOverride: null,
};

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface PreferenceRow {
  author_id: string;
  master_enabled: number;
  audit_fail_enabled: number;
  audit_fail_mode: string;
  audit_error_enabled: number;
  audit_error_mode: string;
  audit_warn_enabled: number;
  audit_warn_mode: string;
  audit_pass_enabled: number;
  audit_pass_mode: string;
  revoke_version_enabled: number;
  revoke_version_mode: string;
  revoke_plugin_enabled: number;
  revoke_plugin_mode: string;
  report_filed_enabled: number;
  report_filed_mode: string;
  email_override: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPreferences(row: PreferenceRow): NotificationPreferences {
  return {
    authorId: row.author_id,
    masterEnabled: row.master_enabled === 1,
    auditFailEnabled: row.audit_fail_enabled === 1,
    auditFailMode: row.audit_fail_mode as NotificationDeliveryMode,
    auditErrorEnabled: row.audit_error_enabled === 1,
    auditErrorMode: row.audit_error_mode as NotificationDeliveryMode,
    auditWarnEnabled: row.audit_warn_enabled === 1,
    auditWarnMode: row.audit_warn_mode as NotificationDeliveryMode,
    auditPassEnabled: row.audit_pass_enabled === 1,
    auditPassMode: row.audit_pass_mode as NotificationDeliveryMode,
    revokeVersionEnabled: row.revoke_version_enabled === 1,
    revokeVersionMode: row.revoke_version_mode as NotificationDeliveryMode,
    revokePluginEnabled: row.revoke_plugin_enabled === 1,
    revokePluginMode: row.revoke_plugin_mode as NotificationDeliveryMode,
    reportFiledEnabled: row.report_filed_enabled === 1,
    reportFiledMode: row.report_filed_mode as NotificationDeliveryMode,
    emailOverride: row.email_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// getPreferencesForAuthor
// ---------------------------------------------------------------------------

/**
 * Get (or lazily create + get) the preference row for an author.
 *
 * The `INSERT OR IGNORE` means two concurrent reads on the same new
 * author both succeed: the first inserts, the second is a no-op, both
 * then read the same row.
 */
export async function getPreferencesForAuthor(
  db: D1Database,
  authorId: string,
): Promise<NotificationPreferences> {
  // Lazy insert: the CHECK defaults + migration DEFAULT clauses handle
  // every column shape.
  await db
    .prepare(
      `INSERT OR IGNORE INTO notification_preferences (author_id) VALUES (?)`,
    )
    .bind(authorId)
    .run();

  const row = await db
    .prepare(
      `SELECT * FROM notification_preferences WHERE author_id = ?`,
    )
    .bind(authorId)
    .first<PreferenceRow>();

  if (!row) {
    // Should be unreachable — the INSERT OR IGNORE above guarantees a row.
    throw new Error(
      `[preferences] Failed to retrieve or create preferences row for ${authorId}`,
    );
  }

  return rowToPreferences(row);
}

// ---------------------------------------------------------------------------
// upsertPreferences
// ---------------------------------------------------------------------------

/**
 * Camel-case key → snake_case D1 column. The Set form is the allow-list
 * used by `upsertPreferences` to gate which update keys reach the SQL
 * layer (T-02 mitigation: column names cannot be user-supplied strings).
 */
const UPDATABLE_FIELDS: Record<string, string> = {
  masterEnabled: "master_enabled",
  auditFailEnabled: "audit_fail_enabled",
  auditFailMode: "audit_fail_mode",
  auditErrorEnabled: "audit_error_enabled",
  auditErrorMode: "audit_error_mode",
  auditWarnEnabled: "audit_warn_enabled",
  auditWarnMode: "audit_warn_mode",
  auditPassEnabled: "audit_pass_enabled",
  auditPassMode: "audit_pass_mode",
  revokeVersionEnabled: "revoke_version_enabled",
  revokeVersionMode: "revoke_version_mode",
  revokePluginEnabled: "revoke_plugin_enabled",
  revokePluginMode: "revoke_plugin_mode",
  reportFiledEnabled: "report_filed_enabled",
  reportFiledMode: "report_filed_mode",
  emailOverride: "email_override",
};

/**
 * Patch a preference row. Only fields in `UPDATABLE_FIELDS` are written;
 * unknown keys on the `updates` object are silently dropped.
 *
 * Booleans are converted to 1/0 at bind time; string fields are bound as-is.
 */
export async function upsertPreferences(
  db: D1Database,
  authorId: string,
  updates: Partial<NotificationPreferences> | Record<string, unknown>,
): Promise<void> {
  const setFragments: string[] = [];
  const bindValues: (string | number | null)[] = [];

  for (const [key, col] of Object.entries(UPDATABLE_FIELDS)) {
    if (!(key in updates)) continue;
    const value = (updates as Record<string, unknown>)[key];
    setFragments.push(`${col} = ?`);
    if (typeof value === "boolean") {
      bindValues.push(value ? 1 : 0);
    } else if (value === null || value === undefined) {
      bindValues.push(null);
    } else {
      bindValues.push(String(value));
    }
  }

  if (setFragments.length === 0) return;

  // Lazy insert so first-write semantics match first-read: an author's
  // row may not exist yet (the migration intentionally does not backfill
  // — see the comment on `getPreferencesForAuthor`). Without this the
  // subsequent UPDATE would silently no-op.
  await db
    .prepare(
      `INSERT OR IGNORE INTO notification_preferences (author_id) VALUES (?)`,
    )
    .bind(authorId)
    .run();

  // Always bump updated_at
  setFragments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  bindValues.push(authorId);

  await db
    .prepare(
      `UPDATE notification_preferences SET ${setFragments.join(", ")} WHERE author_id = ?`,
    )
    .bind(...bindValues)
    .run();
}

// ---------------------------------------------------------------------------
// isEventEnabled / getDeliveryMode
// ---------------------------------------------------------------------------

/**
 * Is this event allowed to fire for this author?
 *
 * `test_send` is a special case: it's always allowed (invoked by the
 * "Send test email" button, bypasses master_enabled so publishers can
 * verify delivery works even if they've paused notifications).
 *
 * `digest` is never checked via this function — digest eligibility is
 * per-event at emit time, not a master check.
 */
export function isEventEnabled(
  prefs: NotificationPreferences,
  eventType: NotificationEventType,
): boolean {
  if (eventType === "test_send") return true;
  if (!prefs.masterEnabled) return false;
  switch (eventType) {
    case "audit_fail":
      return prefs.auditFailEnabled;
    case "audit_error":
      return prefs.auditErrorEnabled;
    case "audit_warn":
      return prefs.auditWarnEnabled;
    case "audit_pass":
      return prefs.auditPassEnabled;
    case "revoke_version":
      return prefs.revokeVersionEnabled;
    case "revoke_plugin":
      return prefs.revokePluginEnabled;
    case "report_filed":
      return prefs.reportFiledEnabled;
    case "digest":
      return false;
    default: {
      // Exhaustiveness guard for future event types
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}

/**
 * Return the delivery mode ('immediate' | 'daily_digest') for an event.
 *
 * For `test_send` and `digest`, this is always 'immediate'.
 */
export function getDeliveryMode(
  prefs: NotificationPreferences,
  eventType: NotificationEventType,
): NotificationDeliveryMode {
  switch (eventType) {
    case "audit_fail":
      return prefs.auditFailMode;
    case "audit_error":
      return prefs.auditErrorMode;
    case "audit_warn":
      return prefs.auditWarnMode;
    case "audit_pass":
      return prefs.auditPassMode;
    case "revoke_version":
      return prefs.revokeVersionMode;
    case "revoke_plugin":
      return prefs.revokePluginMode;
    case "report_filed":
      return prefs.reportFiledMode;
    case "test_send":
    case "digest":
      return "immediate";
    default: {
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveEffectiveEmail
// ---------------------------------------------------------------------------

/**
 * Pick the address we should send to, or `null` to suppress delivery.
 *
 * Order of precedence:
 *   1. If the author's email has bounced hard (`emailBouncedAt` set),
 *      return `null` — D-22 says the channel stays "enabled" but
 *      silently refuses to send until the flag is manually cleared.
 *      This is the signal the dashboard banner uses.
 *   2. If `emailOverride` is set and passes minimal validation, use it.
 *   3. Fall back to the GitHub-pulled `author.email`.
 *   4. Return `null` if nothing is usable.
 *
 * Minimal validation (T-03 mitigation — header injection):
 *   - length <= 320 (RFC 5321 limit)
 *   - contains '@'
 *   - no CRLF (prevents SMTP header injection; Unosend's JSON API is
 *     also immune but we belt-and-brace at the application layer)
 */
export function resolveEffectiveEmail(
  author: { email: string | null; emailBouncedAt: string | null },
  prefs: { emailOverride: string | null },
): string | null {
  // Hard bounces silently suppress delivery until manually cleared (D-22, D-24).
  if (author.emailBouncedAt) return null;

  const candidate = prefs.emailOverride ?? author.email;
  if (!candidate) return null;
  if (candidate.length > 320) return null;
  if (!candidate.includes("@")) return null;
  if (candidate.includes("\r") || candidate.includes("\n")) return null;
  return candidate;
}
