-- 0023_weekly_digests.sql
-- Phase 14: Feeds and Weekly Digest — permanent weekly snapshots indexed
-- by ISO 8601 week slug. See .planning/phases/14-feeds-and-weekly-digest/
-- 14-CONTEXT.md D-19..D-26 and 14-RESEARCH.md §8 for rationale.
--
-- Snapshot-in-manifest strategy (D-20): manifest_json captures the full
-- week payload so /digest/YYYY-Www can render without touching live
-- plugins/themes/plugin_versions tables. An archived digest continues to
-- render correctly even after its plugins are revoked, renamed, or
-- removed. Redaction is manual per D-21 (UPDATE ... SET manifest_json).

CREATE TABLE weekly_digests (
  iso_week      TEXT PRIMARY KEY,   -- "YYYY-Www" (e.g. "2026-W15")
  generated_at  TEXT NOT NULL,      -- ISO8601 UTC, set by the cron handler
  manifest_json TEXT NOT NULL       -- self-contained snapshot payload
);

-- Feed query performance — future-proofs the Phase 14 feed routes and
-- the weekly-digest snapshot window query as the catalog grows.
-- Cost: three small indexes (<1 MB at current scale).
CREATE INDEX IF NOT EXISTS idx_plugins_created_at
  ON plugins (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_themes_created_at
  ON themes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_published_at
  ON plugin_versions (published_at DESC, created_at DESC)
  WHERE status IN ('published', 'flagged');
