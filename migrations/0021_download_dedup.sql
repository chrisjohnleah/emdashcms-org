-- Migration 0021: Anti-fraud dedup for download counters
--
-- Migrations 0019/0020 added raw `downloads_count` columns but had no
-- per-user dedup — clicking "Download v0.2.4" ten times in a minute
-- would count ten times, which makes the popularity surface trivially
-- spammable. The 60/min per-IP rate limit on the bundle endpoint only
-- defends against flood spam, not against an organic user reload-
-- spamming the page.
--
-- This migration adds two dedup tables that mirror how `installs` uses
-- `site_hash`: each row is a unique (hashed-ip, plugin/version) tuple,
-- enforced by a unique index. The download tracker does an
-- INSERT OR IGNORE — and only bumps the counter when meta.changes > 0,
-- meaning the row was genuinely new. The same IP downloading the same
-- version only ever counts once, lifetime.
--
-- Privacy
-- -------
-- We never store raw IPs. The ip_hash column is SHA-256(IP + ":" +
-- plugin_id) for plugin downloads, and SHA-256(IP + ":theme:" +
-- theme_id) for theme outbound clicks. Per-target salting means a
-- compromised dedup table cannot be used to correlate "IP X downloaded
-- plugins A, B, C" — each (IP, target) pair produces a different hash.
--
-- Storage
-- -------
-- Each row is ~80 bytes (PK + ip_hash + plugin_id + version). 1M rows
-- ≈ 80 MB, well inside D1's 5 GB free-tier ceiling. We can prune
-- "older than N months" later if storage ever becomes a concern;
-- for now we keep history forever so the lifetime dedup is honest.

CREATE TABLE download_dedup (
    ip_hash TEXT NOT NULL,
    plugin_id TEXT NOT NULL REFERENCES plugins(id),
    version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (ip_hash, plugin_id, version)
);

CREATE INDEX idx_download_dedup_plugin
    ON download_dedup(plugin_id, version);

CREATE TABLE theme_download_dedup (
    ip_hash TEXT NOT NULL,
    theme_id TEXT NOT NULL REFERENCES themes(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (ip_hash, theme_id)
);

CREATE INDEX idx_theme_download_dedup_theme
    ON theme_download_dedup(theme_id);
