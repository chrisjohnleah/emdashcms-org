# Notifications — `src/lib/notifications/`

**Shipped channel surface (Phase 12, 2026-04-09):**
Unosend email + Queue + DLQ + per-event preferences.

That is the entire delivery story. Nothing else ships in this directory.
Specifically there is **no** GitHub-comment channel, **no** GitHub
check-run channel, and **no** outbound webhook channel — those were
considered during v1.1 planning and deferred to v1.3 with an explicit
trigger condition recorded in
[`.planning/REQUIREMENTS.md`](../../../.planning/REQUIREMENTS.md) under
"Future Requirements".

## Pipeline at a glance

1. **Hook site** (audit consumer / report POST / admin revoke) calls an
   emitter in `emitter.ts`.
2. **emitter.ts** resolves recipients via `fan-out.ts` (plugin owner +
   maintainers; contributors excluded — D-11), derives a deterministic
   idempotency key per recipient (`idempotency.ts`), and enqueues a
   `NotificationJob` to `NOTIF_QUEUE` via `queue.ts`. Emit failures
   never propagate.
3. **consumer.ts** drains `NOTIF_QUEUE` with at-most-once semantics:
   load preferences, resolve effective email
   (`preference-queries.ts`), claim delivery row
   (`delivery-queries.ts` — `INSERT OR IGNORE` on idempotency key),
   render via `templates.ts`, send via `unosend-client.ts`, mark sent
   or failed. Transient Unosend errors `message.retry()` with backoff;
   permanent errors land in `emdashcms-notifications-dlq`.
4. **bounce-webhook-verify.ts** receives Unosend bounce webhooks
   (HMAC-verified) and flips `email_bounced_at` on the author row so
   the consumer skips that recipient on future jobs until they update
   their email in `/dashboard/settings`.
5. **digest.ts** (cron `5 9 * * *` UTC) rolls
   `deliveryMode: 'daily_digest'` rows into one email per recipient
   per day.

## Why email-only, why Unosend

The decision is logged with full rationale in
[`.planning/PROJECT.md`](../../../.planning/PROJECT.md) under
**Key Decisions → "Notifications shipped Unosend-only — supersedes
'GitHub-native preferred' decision (2026-04-27)"**.

Short version: GitHub release comments would have required a different
App scope on every consumer's repo (we can't comment on a publisher's
repo about their plugin's audit verdict without it), and outbound
webhooks would have required every publisher to stand up a receiver.
Email — via Unosend's transactional API with hard-bounce handling —
gave every publisher with a verified address day-one feedback at zero
onboarding cost.

## Adding a new event type (Phase 12 extension path)

1. Add the event to the `NotificationEvent` enum in `schemas.ts`.
2. Migrate `notification_preferences` to default the new per-event
   toggle on (or off, with documented reason).
3. Add a renderer in `templates.ts`.
4. Add an emitter function in `emitter.ts` and call it from the
   relevant hook site.
5. Add the toggle to `/dashboard/settings` (`settings-handlers.ts`).
6. Integration test: hook fires → queue receives job → consumer sends
   → idempotency key blocks duplicate sends → bounce flag
   short-circuits.

## Adding a new channel (defer to v1.3)

Don't. The trigger condition is documented; if neither half of it has
fired, you do not need a new channel. If a trigger has fired, that is
its own GSD phase: schema for channel-typed preferences, channel-typed
templates, channel-typed delivery tables, and per-channel rate
limiting all want to be designed together rather than retrofitted onto
the email-only pipeline one Slack-DM PR at a time.
