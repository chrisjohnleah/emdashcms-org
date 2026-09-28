-- Security audits of plugins in the official EmDash registry
-- (registry.emdashcms.com), shown on the /registry mirror pages.
--
-- Separate from plugin_audits: registry plugins have no row in plugins /
-- plugin_versions, and an audit here never changes anything's publish
-- status — it only annotates the mirror page. One row per release; a
-- 'error' row means the audit could not complete and is shown as such
-- (never as a pass).

CREATE TABLE registry_audits (
  did TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'error')),
  verdict TEXT CHECK (verdict IN ('pass', 'warn', 'fail')),
  risk_score INTEGER,
  findings TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  neurons_used INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (did, slug, version)
);

-- Daily registry spend is summed from this table to enforce its own cap.
CREATE INDEX idx_registry_audits_created_at ON registry_audits (created_at);
