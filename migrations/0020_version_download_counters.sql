-- Migration 0020: Per-version download counters
--
-- Migration 0019 added a plugin-level `downloads_count` so we knew how
-- popular a plugin was overall. That's the right surface for browse
-- listings, but it loses the per-version trend — we can't tell whether
-- v0.2.4 is climbing while v0.2.3 is dropping, the way you'd see in a
-- Search Console "by URL" report.
--
-- This migration adds the same counter to each version row so the
-- bundle endpoint can bump both numbers in one waitUntil. The
-- per-version count powers an admin/dashboard table that shows which
-- versions are getting traction.
--
-- Append-only and aggregate-only — no per-event row, same shape as the
-- plugin-level counter so the admin UI can render both side by side.

ALTER TABLE plugin_versions
  ADD COLUMN downloads_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_plugin_versions_downloads
  ON plugin_versions(plugin_id, downloads_count DESC);
