-- 0001_initial_schema.sql
-- EmDash CMS Community Marketplace - Initial Schema
-- Tables: authors, plugins, plugin_versions, plugin_audits, installs, themes

-- Authors: GitHub-authenticated publishers
CREATE TABLE authors (
    id TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL UNIQUE,
    github_username TEXT NOT NULL,
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plugins: registered plugin entries
CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES authors(id),
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    repository_url TEXT,
    homepage_url TEXT,
    icon_key TEXT,
    installs_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_plugins_author ON plugins(author_id);
CREATE INDEX idx_plugins_category ON plugins(category);
CREATE INDEX idx_plugins_installs ON plugins(installs_count DESC);

-- Plugin versions: each uploaded version with audit status
CREATE TABLE plugin_versions (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins(id),
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    bundle_key TEXT NOT NULL,
    manifest TEXT NOT NULL,
    file_count INTEGER,
    compressed_size INTEGER,
    decompressed_size INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(plugin_id, version)
);

CREATE INDEX idx_versions_plugin ON plugin_versions(plugin_id);
CREATE INDEX idx_versions_status ON plugin_versions(status);
CREATE INDEX idx_versions_plugin_status ON plugin_versions(plugin_id, status);

-- Plugin audits: AI audit results per version
CREATE TABLE plugin_audits (
    id TEXT PRIMARY KEY,
    plugin_version_id TEXT NOT NULL REFERENCES plugin_versions(id),
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    neurons_used INTEGER,
    raw_response TEXT,
    issues TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audits_version ON plugin_audits(plugin_version_id);

-- Install tracking: non-identifying, aggregate only
CREATE TABLE installs (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_installs_plugin ON installs(plugin_id);
CREATE INDEX idx_installs_date ON installs(created_at);

-- Themes: metadata-only listings (no bundles)
CREATE TABLE themes (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES authors(id),
    name TEXT NOT NULL,
    description TEXT,
    keywords TEXT DEFAULT '[]',
    repository_url TEXT,
    demo_url TEXT,
    thumbnail_key TEXT,
    npm_package TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_themes_author ON themes(author_id);
