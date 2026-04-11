import { describe, it } from "vitest";
// Verifies migration 0023_weekly_digests.sql applies cleanly and the
// weekly_digests table + three feed-perf indexes exist in the test D1.
describe("migration 0023_weekly_digests", () => {
  it.todo("weekly_digests table exists with (iso_week, generated_at, manifest_json)");
  it.todo(
    "iso_week is the primary key (rejects duplicate inserts unless REPLACE)",
  );
  it.todo("idx_plugins_created_at exists on plugins (created_at DESC)");
  it.todo("idx_themes_created_at exists on themes (created_at DESC)");
  it.todo(
    "idx_plugin_versions_published_at exists as a partial index on plugin_versions filtered by status IN (published, flagged)",
  );
});
