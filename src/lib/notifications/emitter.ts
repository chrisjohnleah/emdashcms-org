/**
 * Notification emitters called from hook sites.
 *
 * Each emitter:
 *   1. Resolves recipients via fan-out (owner + maintainers — D-11/D-12/D-13)
 *   2. Derives a deterministic idempotency key per recipient
 *   3. Enqueues a NotificationJob to NOTIF_QUEUE
 *
 * Emit failures MUST NOT propagate. The originating operation (audit
 * completion, report creation, revoke action) is authoritative — it
 * has to succeed even if notifications are broken. Every external call
 * (fan-out, spam-cap, queue.send) is wrapped in try/catch and the
 * function always returns a resolved Promise.
 *
 * The hook sites in src/lib/audit/consumer.ts, src/pages/api/v1/reports/index.ts,
 * and src/pages/api/v1/admin/plugins/[...id]/{revoke,revoke-version}.ts
 * additionally wrap the calls below in their own try/catch as a
 * belt-and-braces guard.
 */

import { enqueueNotificationJob } from "./queue";
import { resolveRecipients, type Recipient } from "./fan-out";
import { shouldSendReportNotification } from "./spam-cap";
import { deriveIdempotencyKey } from "./idempotency";
import type {
  NotificationJob,
  NotificationEventType,
} from "../../types/marketplace";

// ---------------------------------------------------------------------------
// Audit emission
// ---------------------------------------------------------------------------

export interface EmitAuditNotificationParams {
  /** The auditId returned by createAuditRecord — also the eventId for idempotency. */
  auditId: string;
  /** Plugin (or theme) id — fan-out resolves both via UNION ALL. */
  pluginId: string;
  pluginName: string;
  version: string;
  /** `null` indicates an error verdict (audit_error). */
  verdict: "pass" | "warn" | "fail" | null;
  riskScore: number;
  findingCount: number;
  errorMessage?: string;
  /**
   * Up to 3 highest-severity findings, surfaced in the audit_fail
   * email body so the publisher can act without round-tripping to
   * the dashboard. Caller is responsible for slicing + ordering.
   */
  topFindings?: { severity: string; title: string }[];
}

function verdictToEventType(
  verdict: "pass" | "warn" | "fail" | null,
): NotificationEventType {
  if (verdict === "pass") return "audit_pass";
  if (verdict === "warn") return "audit_warn";
  if (verdict === "fail") return "audit_fail";
  return "audit_error";
}

/**
 * Emit notifications for an audit terminal-state transition.
 *
 * Audit events currently fire only for plugins. The fan-out call uses
 * `entityType: "plugin"` because `getCollaborators` does a UNION ALL
 * across plugins and themes — passing the plugin id is sufficient.
 */
export async function emitAuditNotification(
  db: D1Database,
  queue: Queue,
  params: EmitAuditNotificationParams,
): Promise<void> {
  let recipients: Recipient[];
  try {
    recipients = await resolveRecipients(db, "plugin", params.pluginId);
  } catch (err) {
    console.error(
      `[notifications] fan-out failed for plugin=${params.pluginId}:`,
      err,
    );
    return;
  }

  if (recipients.length === 0) {
    console.warn(
      `[notifications] audit emit found zero recipients plugin=${params.pluginId} version=${params.version} — check plugin_collaborators rows`,
    );
    return;
  }

  const eventType = verdictToEventType(params.verdict);

  for (const recipient of recipients) {
    try {
      const idempotencyKey = await deriveIdempotencyKey(
        params.auditId,
        recipient.authorId,
      );
      const job: NotificationJob = {
        eventType,
        eventId: params.auditId,
        entityType: "plugin",
        entityId: params.pluginId,
        recipientAuthorId: recipient.authorId,
        // Consumer re-checks per-author preferences and may flip this to
        // 'daily_digest' before claiming the delivery row. Emitter defaults
        // to immediate so digest opt-in is a consumer-side concern.
        deliveryMode: "immediate",
        payload: {
          idempotencyKey,
          pluginName: params.pluginName,
          version: params.version,
          verdict: params.verdict,
          riskScore: params.riskScore,
          findingCount: params.findingCount,
          errorMessage: params.errorMessage ?? null,
          topFindings: params.topFindings ?? [],
        },
      };
      await enqueueNotificationJob(queue, job);
    } catch (err) {
      console.error(
        `[notifications] enqueue failed eventType=${eventType} recipient=${recipient.authorId}:`,
        err,
      );
      // Continue to the next recipient — one bad enqueue must not block the rest.
    }
  }
}

// ---------------------------------------------------------------------------
// Report emission
// ---------------------------------------------------------------------------

export interface EmitReportNotificationParams {
  reportId: string;
  entityType: "plugin" | "theme";
  entityId: string;
  entityName: string;
  category: string;
  /** Caller (the report POST handler) trims this to <= 200 chars per D-18. */
  descriptionExcerpt: string;
}

/**
 * Emit notifications for a freshly-filed report.
 *
 * Honours the per-entity 24h spam cap (D-20) BEFORE fan-out: the cap
 * runs on the entity, not on each recipient, so suppressing once is
 * cheaper than suppressing per recipient downstream.
 *
 * The reporter's identity is intentionally absent from the payload —
 * D-18 keeps reports unattributed to prevent harassment of reporters.
 */
export async function emitReportNotification(
  db: D1Database,
  queue: Queue,
  params: EmitReportNotificationParams,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await shouldSendReportNotification(
      db,
      params.entityType,
      params.entityId,
    );
  } catch (err) {
    console.error(
      `[notifications] spam-cap check failed for ${params.entityType}=${params.entityId}:`,
      err,
    );
    return;
  }
  if (!allowed) {
    console.log(
      `[notifications] report for ${params.entityType}=${params.entityId} suppressed by 24h spam cap`,
    );
    return;
  }

  let recipients: Recipient[];
  try {
    recipients = await resolveRecipients(
      db,
      params.entityType,
      params.entityId,
    );
  } catch (err) {
    console.error(
      `[notifications] fan-out failed for report ${params.entityType}=${params.entityId}:`,
      err,
    );
    return;
  }

  if (recipients.length === 0) {
    console.warn(
      `[notifications] report emit found zero recipients ${params.entityType}=${params.entityId}`,
    );
    return;
  }

  for (const recipient of recipients) {
    try {
      const idempotencyKey = await deriveIdempotencyKey(
        params.reportId,
        recipient.authorId,
      );
      const job: NotificationJob = {
        eventType: "report_filed",
        eventId: params.reportId,
        entityType: params.entityType,
        entityId: params.entityId,
        recipientAuthorId: recipient.authorId,
        deliveryMode: "immediate",
        payload: {
          idempotencyKey,
          entityType: params.entityType,
          entityName: params.entityName,
          category: params.category,
          descriptionExcerpt: params.descriptionExcerpt,
          // NOTE: reporter identity is deliberately omitted (D-18).
        },
      };
      await enqueueNotificationJob(queue, job);
    } catch (err) {
      console.error(
        `[notifications] report enqueue failed recipient=${recipient.authorId}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Revoke emission (version + plugin scopes)
// ---------------------------------------------------------------------------

export interface EmitRevokeNotificationParams {
  /**
   * For version revoke: the auditId from createAuditRecord (admin-action audit row).
   * For plugin revoke: a synthesised string like `revoke-plugin:<id>:<timestamp>`
   * since the plugin-revoke route does not write an audit row today.
   */
  eventId: string;
  scope: "version" | "plugin";
  entityType: "plugin" | "theme";
  entityId: string;
  entityName: string;
  /** Required when scope === 'version'. */
  version?: string;
  reason: string;
  /**
   * Public note text (D-16). Pass `null` when public_note=0 — the
   * template renders the note paragraph only when this is a non-empty
   * string. Templates handle escaping; emitter passes raw values.
   */
  publicNote: string | null;
}

export async function emitRevokeNotification(
  db: D1Database,
  queue: Queue,
  params: EmitRevokeNotificationParams,
): Promise<void> {
  let recipients: Recipient[];
  try {
    recipients = await resolveRecipients(
      db,
      params.entityType,
      params.entityId,
    );
  } catch (err) {
    console.error(
      `[notifications] fan-out failed for revoke ${params.entityType}=${params.entityId}:`,
      err,
    );
    return;
  }

  if (recipients.length === 0) {
    console.warn(
      `[notifications] revoke emit found zero recipients ${params.entityType}=${params.entityId}`,
    );
    return;
  }

  const eventType: NotificationEventType =
    params.scope === "version" ? "revoke_version" : "revoke_plugin";

  for (const recipient of recipients) {
    try {
      const idempotencyKey = await deriveIdempotencyKey(
        params.eventId,
        recipient.authorId,
      );
      const job: NotificationJob = {
        eventType,
        eventId: params.eventId,
        entityType: params.entityType,
        entityId: params.entityId,
        recipientAuthorId: recipient.authorId,
        deliveryMode: "immediate",
        payload: {
          idempotencyKey,
          scope: params.scope,
          entityName: params.entityName,
          version: params.version ?? null,
          reason: params.reason,
          publicNote: params.publicNote,
        },
      };
      await enqueueNotificationJob(queue, job);
    } catch (err) {
      console.error(
        `[notifications] revoke enqueue failed recipient=${recipient.authorId}:`,
        err,
      );
    }
  }
}
