-- Plugin/theme collaborators with role-based access
-- Ownership lives in plugins.author_id / themes.author_id (not duplicated here)
-- plugin_id serves both plugins and themes (same pattern as plugin_github_links)
CREATE TABLE plugin_collaborators (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES authors(id),
  role TEXT NOT NULL CHECK(role IN ('maintainer', 'contributor')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(plugin_id, author_id)
);

CREATE INDEX idx_collaborators_plugin ON plugin_collaborators(plugin_id);
CREATE INDEX idx_collaborators_author ON plugin_collaborators(author_id);

-- Pending invitations by GitHub username
-- COLLATE NOCASE on invited_github_username handles GitHub's case-insensitive usernames
CREATE TABLE plugin_invites (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  invited_github_username TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('maintainer', 'contributor')),
  invited_by TEXT NOT NULL REFERENCES authors(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL,
  UNIQUE(plugin_id, invited_github_username, status)
);

CREATE INDEX idx_invites_plugin ON plugin_invites(plugin_id);
CREATE INDEX idx_invites_username ON plugin_invites(invited_github_username);
CREATE INDEX idx_invites_status ON plugin_invites(status);
