-- Add short_description (tagline) for cards/search, and category for themes.
-- Existing columns already cover: plugins.icon_key, plugins.category,
-- themes.screenshot_keys, plugin_versions.screenshots.

ALTER TABLE plugins ADD COLUMN short_description TEXT;
ALTER TABLE themes ADD COLUMN short_description TEXT;
ALTER TABLE themes ADD COLUMN category TEXT;
