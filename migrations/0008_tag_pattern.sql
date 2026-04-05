-- Add tag pattern column for publisher-configurable release tag matching
ALTER TABLE plugin_github_links ADD COLUMN tag_pattern TEXT NOT NULL DEFAULT '*';
