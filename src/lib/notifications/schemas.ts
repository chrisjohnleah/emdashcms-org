/**
 * Zod/mini schemas for notification pipeline payloads.
 *
 * Two schemas live here:
 *   1. `notificationJobSchema` — validates NOTIF_QUEUE message bodies
 *      before the consumer acts on them. Mirrors the TypeScript
 *      `NotificationJob` interface from src/types/marketplace.ts.
 *   2. `unosendBounceEventSchema` — validates webhook bodies on the
 *      Unosend bounce endpoint (added in Plan 12-02) AFTER the HMAC
 *      signature has been verified. Parse failures must be logged as
 *      hard errors per Pitfall 2 in 12-RESEARCH.md.
 */

import * as z from "zod/mini";

export const notificationEventTypeSchema = z.enum([
  "audit_fail",
  "audit_error",
  "audit_warn",
  "audit_pass",
  "revoke_version",
  "revoke_plugin",
  "report_filed",
  "test_send",
  "digest",
]);

export const notificationEntityTypeSchema = z.enum([
  "plugin",
  "theme",
  "none",
]);

export const notificationDeliveryModeSchema = z.enum([
  "immediate",
  "daily_digest",
]);

export const notificationJobSchema = z.object({
  eventType: notificationEventTypeSchema,
  eventId: z.string().check(z.minLength(1)),
  entityType: notificationEntityTypeSchema,
  entityId: z.nullable(z.string()),
  recipientAuthorId: z.string().check(z.minLength(1)),
  deliveryMode: notificationDeliveryModeSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const unosendBounceEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created_at: z.string(),
  data: z.object({
    email: z.string(),
    email_id: z.optional(z.string()),
    bounce_type: z.optional(z.enum(["hard", "soft"])),
    bounce_reason: z.optional(z.string()),
  }),
});

export type NotificationJobParsed = z.infer<typeof notificationJobSchema>;
export type UnosendBounceEventParsed = z.infer<typeof unosendBounceEventSchema>;
