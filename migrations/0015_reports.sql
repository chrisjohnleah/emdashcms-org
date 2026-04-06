-- Reports: end-user and author-initiated reports of plugins and themes.
-- Anonymous reports allowed (reporter_author_id nullable). Status lifecycle:
--   open -> investigating -> resolved | dismissed
-- Resolution note is optional free-text written by the moderator who closed
-- the report. resolved_by_author_id tracks which admin handled it.

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('plugin', 'theme')),
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

CREATE INDEX IF NOT EXISTS idx_reports_entity ON reports (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports (reporter_author_id);
