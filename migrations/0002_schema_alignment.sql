-- 0002_schema_alignment.sql
-- Align D1 schema with MarketplaceClient API contract types
-- Adds 14 missing columns across 5 tables

-- plugins: add keywords (JSON array) and license
ALTER TABLE plugins ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plugins ADD COLUMN license TEXT;

-- plugin_versions: add version detail fields
ALTER TABLE plugin_versions ADD COLUMN min_emdash_version TEXT;
ALTER TABLE plugin_versions ADD COLUMN checksum TEXT NOT NULL DEFAULT '';
ALTER TABLE plugin_versions ADD COLUMN changelog TEXT;
ALTER TABLE plugin_versions ADD COLUMN readme TEXT;
ALTER TABLE plugin_versions ADD COLUMN published_at TEXT;

-- plugin_audits: add verdict, risk_score, findings (separate from existing status/issues)
ALTER TABLE plugin_audits ADD COLUMN verdict TEXT;
ALTER TABLE plugin_audits ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_audits ADD COLUMN findings TEXT NOT NULL DEFAULT '[]';

-- authors: add verified flag
ALTER TABLE authors ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

-- themes: add preview_url, homepage_url, license
ALTER TABLE themes ADD COLUMN preview_url TEXT;
ALTER TABLE themes ADD COLUMN homepage_url TEXT;
ALTER TABLE themes ADD COLUMN license TEXT;
