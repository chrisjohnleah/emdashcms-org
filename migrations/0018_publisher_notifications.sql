-- Migration 0018: Publisher notifications (Phase 12)
-- See .planning/phases/12-publisher-notifications/12-CONTEXT.md D-32
--
-- Introduces:
--   1. authors.email + authors.email_bounced_at   (D-04)
--   2. notification_preferences (discrete-column schema per 12-RESEARCH.md Pattern 5)
--   3. notification_deliveries  (at-most-once claim via UNIQUE idempotency_key, D-26)
--   4. plugins/themes.last_report_notification_at (denormalized 24h spam cap, D-20)

-- === 1. Email columns on authors ===
ALTER TABLE authors ADD COLUMN email TEXT;
ALTER TABLE authors ADD COLUMN email_bounced_at TEXT;

-- === 2. Per-author preference storage (discrete columns per Pattern 5) ===
-- One row per author. Lazily created on first read via INSERT OR IGNORE, so
-- this migration does NOT backfill existing authors — the row appears the
-- first time the settings page (or the consumer) touches it.
--
-- Defaults (D-08):
--   audit_fail/error/warn: enabled (security & correctness signals)
--   audit_pass:            disabled (chatty, opt-in)
--   revoke_version/plugin: enabled (high-importance publisher actions)
--   report_filed:          disabled (chatty + spam vector, opt-in)
--   all modes:             'immediate'
--   master_enabled:        on
CREATE TABLE notification_preferences (
  author_id TEXT PRIMARY KEY,
  master_enabled INTEGER NOT NULL DEFAULT 1,

  audit_fail_enabled     INTEGER NOT NULL DEFAULT 1,
  audit_fail_mode        TEXT    NOT NULL DEFAULT 'immediate' CHECK (audit_fail_mode IN ('immediate','daily_digest')),
  audit_error_enabled    INTEGER NOT NULL DEFAULT 1,
  audit_error_mode       TEXT    NOT NULL DEFAULT 'immediate' CHECK (audit_error_mode IN ('immediate','daily_digest')),
  audit_warn_enabled     INTEGER NOT NULL DEFAULT 1,
  audit_warn_mode        TEXT    NOT NULL DEFAULT 'immediate' CHECK (audit_warn_mode IN ('immediate','daily_digest')),
  audit_pass_enabled     INTEGER NOT NULL DEFAULT 0,
  audit_pass_mode        TEXT    NOT NULL DEFAULT 'immediate' CHECK (audit_pass_mode IN ('immediate','daily_digest')),
  revoke_version_enabled INTEGER NOT NULL DEFAULT 1,
  revoke_version_mode    TEXT    NOT NULL DEFAULT 'immediate' CHECK (revoke_version_mode IN ('immediate','daily_digest')),
  revoke_plugin_enabled  INTEGER NOT NULL DEFAULT 1,
  revoke_plugin_mode     TEXT    NOT NULL DEFAULT 'immediate' CHECK (revoke_plugin_mode IN ('immediate','daily_digest')),
  report_filed_enabled   INTEGER NOT NULL DEFAULT 0,
  report_filed_mode      TEXT    NOT NULL DEFAULT 'immediate' CHECK (report_filed_mode IN ('immediate','daily_digest')),

  -- Manual override address. If NULL, send to authors.email (GitHub-pulled).
  email_override TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- === 3. Delivery tracking with at-most-once idempotency key (D-26) ===
-- INSERT OR IGNORE on `idempotency_key` is the atomic claim primitive used
-- by the queue consumer to de-duplicate redeliveries. `meta.changes === 1`
-- means we're the first worker to see this event; anything else means a
-- prior attempt already claimed it and we should ack without re-sending.
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'audit_fail','audit_error','audit_warn','audit_pass',
    'revoke_version','revoke_plugin','report_filed','test_send','digest'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('plugin','theme','none')),
  entity_id TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'immediate' CHECK (delivery_mode IN ('immediate','daily_digest')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','sent','bounced','skipped','failed'
  )),
  provider_id TEXT,                  -- Unosend eml_xxxxxxxx id on success
  attempt_count INTEGER NOT NULL DEFAULT 0,
  bounced_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Per-author history query (settings page notification log — 50 rows max)
CREATE INDEX idx_notification_deliveries_author_created
  ON notification_deliveries (author_id, created_at DESC);

-- Daily digest aggregation query (queued + daily_digest mode, bounded by created_at window)
CREATE INDEX idx_notification_deliveries_status_mode_created
  ON notification_deliveries (status, delivery_mode, created_at);

-- === 4. Per-entity 24h spam cap for report_filed (D-20, Pattern 6) ===
-- Denormalized column; cheaper than a dedicated cap table because the
-- emission hook needs one SELECT + one UPDATE instead of a JOIN. The
-- column is only read when a report notification fires.
ALTER TABLE plugins ADD COLUMN last_report_notification_at TEXT;
ALTER TABLE themes  ADD COLUMN last_report_notification_at TEXT;
