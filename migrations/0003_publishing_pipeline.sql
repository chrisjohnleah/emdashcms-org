-- 0003_publishing_pipeline.sql
-- Publishing pipeline schema additions
-- Adds support_url/funding_url to plugins (D-05), screenshots/retry_count to plugin_versions (D-06, D-24)

-- plugins: support_url and funding_url (D-05)
ALTER TABLE plugins ADD COLUMN support_url TEXT;
ALTER TABLE plugins ADD COLUMN funding_url TEXT;

-- plugin_versions: screenshots JSON array (D-06) and retry_count (D-24)
ALTER TABLE plugin_versions ADD COLUMN screenshots TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plugin_versions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
