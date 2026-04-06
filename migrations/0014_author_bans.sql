-- Author bans: allow superadmins to suspend an author's ability to publish.
-- A banned author can still view the site and their existing plugins, but:
--   - OAuth callback redirects them to /?banned=1 and refuses to issue a session
--   - Plugin registration POST returns 403
--   - Theme registration POST returns 403
--   - Author profile pages return 404
-- Unbanning clears `banned`, `banned_reason`, and `banned_at`.

ALTER TABLE authors ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE authors ADD COLUMN banned_reason TEXT;
ALTER TABLE authors ADD COLUMN banned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_authors_banned ON authors (banned) WHERE banned = 1;
