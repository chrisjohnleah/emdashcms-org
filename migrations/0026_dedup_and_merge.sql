-- Phase 18: Cross-plugin content dedup + admin merge action.
--
-- Two related moderation gaps motivate this migration:
--
--   1. plugin_versions.checksum (SHA-256 of the tarball) has been
--      stored on every version since 0002 but is never queried for
--      cross-plugin matching. An author whose audit failed could
--      simply re-register the byte-identical bundle under a fresh
--      slug — observed in production with two duplicate plugins from
--      the same author. Adding an index lets the registration handler
--      do an O(1) checksum lookup before creating the plugin row.
--
--   2. When duplicates do slip through (or pre-exist), admins have
--      no graceful collapse path — Delete is destructive, Revoke
--      leaves the plugin visible. The `merged_into` column lets a
--      moderator point one plugin row at its canonical sibling so
--      listings can hide it via WHERE merged_into IS NULL while the
--      row itself stays intact (for audit trail and any inbound
--      links). Self-references are blocked by a CHECK constraint.
--
-- The index on `merged_into` is intentionally omitted — the column is
-- usually NULL and the listing queries already use compound indexes
-- on status/category, so a separate index would just bloat writes.

CREATE INDEX idx_versions_checksum ON plugin_versions (checksum);

ALTER TABLE plugins ADD COLUMN merged_into TEXT
  REFERENCES plugins(id)
  CHECK (merged_into IS NULL OR merged_into != id);

ALTER TABLE plugins ADD COLUMN merged_at TEXT;
ALTER TABLE plugins ADD COLUMN merged_by TEXT;
