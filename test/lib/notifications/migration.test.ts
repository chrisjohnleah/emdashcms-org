import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

/**
 * Migration 0018 shape assertions.
 *
 * These tests do NOT assert behaviour — they assert that the schema shape
 * declared in 12-RESEARCH.md "Example 5" is exactly what landed in the DB
 * after `applyD1Migrations` ran in the test harness.
 *
 * If any of these fail, the migration file has drifted from the plan.
 */

async function getTableSql(table: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(table)
    .first<{ sql: string }>();
  return row?.sql ?? null;
}

async function getIndexSql(index: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  )
    .bind(index)
    .first<{ sql: string }>();
  return row?.sql ?? null;
}

async function getColumnNames(table: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
  }>();
  return (result.results ?? []).map((r) => r.name);
}

describe("migration 0018 — authors.email columns", () => {
  it("adds email column to authors", async () => {
    const cols = await getColumnNames("authors");
    expect(cols).toContain("email");
  });

  it("adds email_bounced_at column to authors", async () => {
    const cols = await getColumnNames("authors");
    expect(cols).toContain("email_bounced_at");
  });
});

describe("migration 0018 — notification_preferences table", () => {
  it("creates the notification_preferences table", async () => {
    const sql = await getTableSql("notification_preferences");
    expect(sql).not.toBeNull();
    expect(sql).toContain("master_enabled");
  });

  it("has all seven per-event-type enabled columns", async () => {
    const cols = await getColumnNames("notification_preferences");
    expect(cols).toContain("audit_fail_enabled");
    expect(cols).toContain("audit_error_enabled");
    expect(cols).toContain("audit_warn_enabled");
    expect(cols).toContain("audit_pass_enabled");
    expect(cols).toContain("revoke_version_enabled");
    expect(cols).toContain("revoke_plugin_enabled");
    expect(cols).toContain("report_filed_enabled");
  });

  it("has all seven per-event-type mode columns", async () => {
    const cols = await getColumnNames("notification_preferences");
    expect(cols).toContain("audit_fail_mode");
    expect(cols).toContain("audit_error_mode");
    expect(cols).toContain("audit_warn_mode");
    expect(cols).toContain("audit_pass_mode");
    expect(cols).toContain("revoke_version_mode");
    expect(cols).toContain("revoke_plugin_mode");
    expect(cols).toContain("report_filed_mode");
  });

  it("has email_override column", async () => {
    const cols = await getColumnNames("notification_preferences");
    expect(cols).toContain("email_override");
  });

  it("matches D-08 defaults: audit_pass opt-in, report_filed opt-in, rest on", async () => {
    // Insert a minimal row with only the primary key — defaults should apply.
    await env.DB.prepare(
      "INSERT INTO notification_preferences (author_id) VALUES (?)",
    )
      .bind("mig-test-author")
      .run();

    const row = await env.DB.prepare(
      "SELECT * FROM notification_preferences WHERE author_id = ?",
    )
      .bind("mig-test-author")
      .first<Record<string, unknown>>();

    expect(row).not.toBeNull();
    expect(row!.master_enabled).toBe(1);
    expect(row!.audit_fail_enabled).toBe(1);
    expect(row!.audit_error_enabled).toBe(1);
    expect(row!.audit_warn_enabled).toBe(1);
    expect(row!.audit_pass_enabled).toBe(0); // opt-in
    expect(row!.revoke_version_enabled).toBe(1);
    expect(row!.revoke_plugin_enabled).toBe(1);
    expect(row!.report_filed_enabled).toBe(0); // opt-in
    expect(row!.audit_fail_mode).toBe("immediate");

    // Clean up
    await env.DB.prepare(
      "DELETE FROM notification_preferences WHERE author_id = ?",
    )
      .bind("mig-test-author")
      .run();
  });
});

describe("migration 0018 — notification_deliveries table", () => {
  it("creates the notification_deliveries table", async () => {
    const sql = await getTableSql("notification_deliveries");
    expect(sql).not.toBeNull();
  });

  it("has UNIQUE constraint on idempotency_key", async () => {
    const sql = await getTableSql("notification_deliveries");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("UNIQUE");
  });

  it("enforces UNIQUE(idempotency_key) at insert time", async () => {
    await env.DB.prepare(
      `INSERT INTO notification_deliveries
        (id, idempotency_key, author_id, event_type, entity_type, entity_id)
       VALUES ('mig-del-1', 'dup-key-mig', 'mig-author', 'audit_fail', 'plugin', 'pl-1')`,
    ).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO notification_deliveries
          (id, idempotency_key, author_id, event_type, entity_type, entity_id)
         VALUES ('mig-del-2', 'dup-key-mig', 'mig-author', 'audit_fail', 'plugin', 'pl-1')`,
      ).run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      "DELETE FROM notification_deliveries WHERE id = ?",
    )
      .bind("mig-del-1")
      .run();
  });

  it("has composite index on (author_id, created_at DESC)", async () => {
    const sql = await getIndexSql("idx_notification_deliveries_author_created");
    expect(sql).not.toBeNull();
    expect(sql).toContain("author_id");
    expect(sql).toContain("created_at");
  });

  it("has composite index on (status, delivery_mode, created_at)", async () => {
    const sql = await getIndexSql(
      "idx_notification_deliveries_status_mode_created",
    );
    expect(sql).not.toBeNull();
    expect(sql).toContain("status");
    expect(sql).toContain("delivery_mode");
  });
});

describe("migration 0018 — entity spam-cap columns", () => {
  it("adds last_report_notification_at to plugins", async () => {
    const cols = await getColumnNames("plugins");
    expect(cols).toContain("last_report_notification_at");
  });

  it("adds last_report_notification_at to themes", async () => {
    const cols = await getColumnNames("themes");
    expect(cols).toContain("last_report_notification_at");
  });
});
