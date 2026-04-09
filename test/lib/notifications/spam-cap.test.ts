import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { shouldSendReportNotification } from "../../../src/lib/notifications/spam-cap";

const OWNER_ID = "sc-owner";
const PLUGIN_ID = "sc-plugin";
const THEME_ID = "sc-theme";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 820001, "sc-owner-user"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, "Spam-cap Plugin", "For spam-cap tests"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, OWNER_ID, "Spam-cap Theme", "For spam-cap tests"),
  ]);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE plugins SET last_report_notification_at = NULL WHERE id = ?",
    ).bind(PLUGIN_ID),
    env.DB.prepare(
      "UPDATE themes  SET last_report_notification_at = NULL WHERE id = ?",
    ).bind(THEME_ID),
  ]);
});

// ---------------------------------------------------------------------------
// shouldSendReportNotification — plugin
// ---------------------------------------------------------------------------

describe("shouldSendReportNotification — plugin", () => {
  it("returns true when last_report_notification_at is NULL", async () => {
    const result = await shouldSendReportNotification(
      env.DB,
      "plugin",
      PLUGIN_ID,
    );
    expect(result).toBe(true);
  });

  it("claims the 24h slot on the same call", async () => {
    await shouldSendReportNotification(env.DB, "plugin", PLUGIN_ID);
    const row = await env.DB.prepare(
      "SELECT last_report_notification_at FROM plugins WHERE id = ?",
    )
      .bind(PLUGIN_ID)
      .first<{ last_report_notification_at: string | null }>();
    expect(row!.last_report_notification_at).not.toBeNull();
  });

  it("returns false on the immediately-following second call", async () => {
    await shouldSendReportNotification(env.DB, "plugin", PLUGIN_ID);
    const second = await shouldSendReportNotification(
      env.DB,
      "plugin",
      PLUGIN_ID,
    );
    expect(second).toBe(false);
  });

  it("returns true again once more than 24h have elapsed", async () => {
    await env.DB.prepare(
      `UPDATE plugins SET last_report_notification_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-25 hours')) WHERE id = ?`,
    )
      .bind(PLUGIN_ID)
      .run();
    const result = await shouldSendReportNotification(
      env.DB,
      "plugin",
      PLUGIN_ID,
    );
    expect(result).toBe(true);
  });

  it("returns false for an unknown plugin id", async () => {
    const result = await shouldSendReportNotification(
      env.DB,
      "plugin",
      "does-not-exist",
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldSendReportNotification — theme
// ---------------------------------------------------------------------------

describe("shouldSendReportNotification — theme", () => {
  it("returns true when last_report_notification_at is NULL", async () => {
    const result = await shouldSendReportNotification(
      env.DB,
      "theme",
      THEME_ID,
    );
    expect(result).toBe(true);
  });

  it("returns false on second call within 24h for themes", async () => {
    await shouldSendReportNotification(env.DB, "theme", THEME_ID);
    const second = await shouldSendReportNotification(
      env.DB,
      "theme",
      THEME_ID,
    );
    expect(second).toBe(false);
  });

  it("returns true after the 24h window has passed for themes", async () => {
    await env.DB.prepare(
      `UPDATE themes SET last_report_notification_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-25 hours')) WHERE id = ?`,
    )
      .bind(THEME_ID)
      .run();
    const result = await shouldSendReportNotification(
      env.DB,
      "theme",
      THEME_ID,
    );
    expect(result).toBe(true);
  });
});
