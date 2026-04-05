-- 0005_downloads_and_rate_limits.sql
-- Install tracking dedup columns and global API rate limiting table
-- Supports: DOWN-01 (bundle download), DOWN-02 (install tracking), DOWN-03 (rate limiting)

-- Add site_hash and version columns to installs table (D-08)
-- Existing rows will have NULL for these columns (legacy rows)
ALTER TABLE installs ADD COLUMN site_hash TEXT;
ALTER TABLE installs ADD COLUMN version TEXT;

-- Dedup constraint: same site+plugin+version only tracked once (D-07)
CREATE UNIQUE INDEX idx_installs_dedup ON installs(plugin_id, site_hash, version);

-- Global API rate limiting table (D-13, D-18)
-- One row per UTC minute bucket, tracking request count
CREATE TABLE rate_limits (
    minute TEXT PRIMARY KEY,
    request_count INTEGER NOT NULL DEFAULT 0
);
