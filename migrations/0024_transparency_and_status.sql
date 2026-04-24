-- Phase 15: weekly transparency snapshots + 5-minute uptime probes.
--
-- transparency_weeks: one row per ISO week of aggregated marketplace
--   metrics. Computed by the Sunday 00:10 UTC cron; idempotent on
--   re-run via INSERT OR REPLACE. All numeric columns — zero identifiers.
--
-- status_samples: rolling 7-day window of uptime probes written by
--   the 5-minute cron. Index on (surface, sampled_at DESC) supports
--   both the per-surface 7-day query and the retention DELETE bounded
--   on sampled_at.

CREATE TABLE transparency_weeks (
  iso_week TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  versions_submitted INTEGER NOT NULL DEFAULT 0,
  versions_published INTEGER NOT NULL DEFAULT 0,
  versions_flagged INTEGER NOT NULL DEFAULT 0,
  versions_rejected INTEGER NOT NULL DEFAULT 0,
  versions_revoked INTEGER NOT NULL DEFAULT 0,
  reports_filed_security INTEGER NOT NULL DEFAULT 0,
  reports_filed_abuse INTEGER NOT NULL DEFAULT 0,
  reports_filed_broken INTEGER NOT NULL DEFAULT 0,
  reports_filed_license INTEGER NOT NULL DEFAULT 0,
  reports_filed_other INTEGER NOT NULL DEFAULT 0,
  reports_resolved INTEGER NOT NULL DEFAULT 0,
  reports_dismissed INTEGER NOT NULL DEFAULT 0,
  neurons_spent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE status_samples (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL CHECK (surface IN (
    'landing', 'plugins_list', 'plugin_detail', 'bundle', 'publishing_api'
  )),
  sampled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'slow', 'fail', 'timeout')),
  http_status INTEGER,
  latency_ms INTEGER
);

CREATE INDEX idx_status_samples_surface_sampled_at
  ON status_samples (surface, sampled_at DESC);
