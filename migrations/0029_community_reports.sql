-- Allow community/code-of-conduct reports to share the existing moderator
-- reports queue without pretending a central forum exists yet.
--
-- SQLite cannot alter a CHECK constraint in place, so rebuild the table with
-- the widened entity_type constraint and re-create the indexes.

CREATE TABLE reports_next (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('plugin', 'theme', 'community')),
  entity_id TEXT NOT NULL,
  reporter_author_id TEXT,
  reason_category TEXT NOT NULL CHECK (reason_category IN ('security', 'abuse', 'broken', 'license', 'other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_note TEXT,
  resolved_by_author_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO reports_next (
  id,
  entity_type,
  entity_id,
  reporter_author_id,
  reason_category,
  description,
  status,
  resolution_note,
  resolved_by_author_id,
  resolved_at,
  created_at
)
SELECT
  id,
  entity_type,
  entity_id,
  reporter_author_id,
  reason_category,
  description,
  status,
  resolution_note,
  resolved_by_author_id,
  resolved_at,
  created_at
FROM reports;

DROP TABLE reports;
ALTER TABLE reports_next RENAME TO reports;

CREATE INDEX IF NOT EXISTS idx_reports_entity ON reports (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports (reporter_author_id);
