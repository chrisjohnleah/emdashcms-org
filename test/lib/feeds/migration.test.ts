import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Verifies migration 0023_weekly_digests.sql is present in the test D1
// (applied automatically by test/setup.ts via applyD1Migrations) and that
// the weekly_digests table + three feed-perf indexes exist with the
// expected shape.

describe("migration 0023_weekly_digests", () => {
  beforeAll(async () => {
    // Defensive cleanup in case a previous test left a row behind.
    await env.DB.prepare("DELETE FROM weekly_digests WHERE iso_week = ?")
      .bind("1999-W01")
      .run();
  });

  afterAll(async () => {
    await env.DB.prepare("DELETE FROM weekly_digests WHERE iso_week = ?")
      .bind("1999-W01")
      .run();
  });

  it("weekly_digests table exists with (iso_week, generated_at, manifest_json)", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='weekly_digests'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("weekly_digests");

    const cols = await env.DB.prepare("PRAGMA table_info('weekly_digests')").all();
    const names = new Set((cols.results ?? []).map((r) => (r as { name: string }).name));
    expect(names.has("iso_week")).toBe(true);
    expect(names.has("generated_at")).toBe(true);
    expect(names.has("manifest_json")).toBe(true);
  });

  it("iso_week is the primary key (rejects duplicate inserts unless REPLACE)", async () => {
    await env.DB.prepare(
      "INSERT INTO weekly_digests (iso_week, generated_at, manifest_json) VALUES (?, ?, ?)",
    )
      .bind("1999-W01", "1999-01-04T00:00:00Z", "{}")
      .run();
    let threw = false;
    try {
      await env.DB.prepare(
        "INSERT INTO weekly_digests (iso_week, generated_at, manifest_json) VALUES (?, ?, ?)",
      )
        .bind("1999-W01", "1999-01-04T00:00:00Z", "{}")
        .run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await env.DB.prepare("DELETE FROM weekly_digests WHERE iso_week = ?")
      .bind("1999-W01")
      .run();
  });

  it("idx_plugins_created_at exists on plugins (created_at DESC)", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_plugins_created_at'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("idx_plugins_created_at");
  });

  it("idx_themes_created_at exists on themes (created_at DESC)", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_themes_created_at'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("idx_themes_created_at");
  });

  it("idx_plugin_versions_published_at exists as a partial index on plugin_versions filtered by status IN (published, flagged)", async () => {
    const row = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_plugin_versions_published_at'",
    ).first<{ name: string; sql: string }>();
    expect(row?.name).toBe("idx_plugin_versions_published_at");
    // Partial index — SQL must mention the status filter clause.
    expect(row?.sql).toContain("status IN ('published', 'flagged')");
  });
});
