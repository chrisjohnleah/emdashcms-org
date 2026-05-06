-- Theme moderation status.
--
-- Plugins already carry a listing-level status so moderators can revoke a
-- whole plugin after reports, compromise, impersonation, or policy abuse.
-- Themes need the same fail-closed control: revoked themes are hidden from
-- public discovery, detail APIs, feeds, sitemap output, and click tracking,
-- while remaining visible to admins for review and restoration.

ALTER TABLE themes ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked'));

CREATE INDEX idx_themes_status ON themes(status);
