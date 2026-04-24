-- Phase 17: Plugin deprecation + unlist self-service (DEPR-01..DEPR-08).
--
-- Two distinct owner actions, stored inline on the plugins row:
--
--   * DEPRECATION is loud. A deprecated plugin stays visible and
--     downloadable (existing installs keep working per DEPR-04) but is
--     demoted in default search sort and renders a prominent warning
--     banner to visitors. Owners record a category + optional 500-char
--     note and may point to a successor plugin.
--
--   * UNLIST is quiet. An unlisted plugin is hidden from search and
--     category pages, but the direct `/plugins/:id` URL and bundle
--     downloads keep working. Intended for plugins the author doesn't
--     want to promote anymore but doesn't want to actively warn about.
--
-- Both states are author-toggleable from the dashboard and can apply
-- independently — a plugin can be unlisted AND deprecated, unlisted
-- only, deprecated only, or neither.
--
-- Audit columns (`deprecated_by`, `unlisted_by`) store the actor author
-- UUID so repudiation threats (T-17-06) are mitigated without a
-- separate events table — matches the inline-column convention from
-- 0017_admin_note_visibility.sql.
--
-- The CHECK constraint on `deprecated_reason_category` enforces the
-- user-locked enum (unmaintained | replaced | abandoned | security |
-- other) OR NULL. SQLite accepts a column-level CHECK on ADD COLUMN as
-- long as it references only that column, which is the case here.
--
-- Three indexes are created:
--   * idx_plugins_deprecated_at supports the default-sort demotion
--     (`(deprecated_at IS NOT NULL) ASC`) on every search query.
--   * idx_plugins_unlisted_at supports the WHERE filter that hides
--     unlisted plugins from search and public-author listings.
--   * idx_plugins_successor_id keeps the successor-chain BFS cycle
--     detection O(depth) rather than O(rows) when walking chains.

ALTER TABLE plugins ADD COLUMN deprecated_at TEXT;
ALTER TABLE plugins ADD COLUMN deprecated_by TEXT;
ALTER TABLE plugins ADD COLUMN deprecated_reason_category TEXT
  CHECK (deprecated_reason_category IS NULL
      OR deprecated_reason_category IN (
        'unmaintained', 'replaced', 'abandoned', 'security', 'other'
      ));
ALTER TABLE plugins ADD COLUMN deprecated_reason_note TEXT;
ALTER TABLE plugins ADD COLUMN successor_id TEXT;
ALTER TABLE plugins ADD COLUMN unlisted_at TEXT;
ALTER TABLE plugins ADD COLUMN unlisted_by TEXT;

CREATE INDEX idx_plugins_deprecated_at ON plugins (deprecated_at);
CREATE INDEX idx_plugins_unlisted_at ON plugins (unlisted_at);
CREATE INDEX idx_plugins_successor_id ON plugins (successor_id);
