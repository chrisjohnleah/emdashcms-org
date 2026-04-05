-- GitHub App installations and plugin-repo links

CREATE TABLE github_installations (
  id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES authors(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_gh_installations_author ON github_installations(author_id);

CREATE TABLE plugin_github_links (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  installation_id INTEGER NOT NULL REFERENCES github_installations(id),
  repo_full_name TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  auto_submit INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(plugin_id)
);

CREATE INDEX idx_gh_links_repo ON plugin_github_links(repo_full_name);
CREATE INDEX idx_gh_links_installation ON plugin_github_links(installation_id);

-- Add source column to plugin_versions to distinguish upload vs webhook
ALTER TABLE plugin_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';
