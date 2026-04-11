-- Migration 0019: Download counters for plugins and themes
--
-- Adds raw download counters distinct from `installs_count`:
--
--   - plugins.downloads_count   incremented on every successful bundle GET
--                               (browser ZIP click + CLI). `installs_count`
--                               remains the dedup'd unique-site CLI metric.
--
--   - themes.downloads_count    incremented when a user clicks through to
--                               an external install target (npm/repo/demo)
--                               from the theme detail page. Themes are
--                               metadata-only with no bundle, so this is
--                               the only signal we can capture.
--
-- Both counters are append-only and aggregate-only — no per-event row.
-- That keeps storage flat and writes cheap on free tier.

ALTER TABLE plugins ADD COLUMN downloads_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE themes  ADD COLUMN downloads_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_plugins_downloads ON plugins(downloads_count DESC);
CREATE INDEX idx_themes_downloads  ON themes(downloads_count DESC);
