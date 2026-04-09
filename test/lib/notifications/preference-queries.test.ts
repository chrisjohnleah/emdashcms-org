import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  DEFAULT_PREFERENCES,
  getPreferencesForAuthor,
  upsertPreferences,
  isEventEnabled,
  getDeliveryMode,
  resolveEffectiveEmail,
} from "../../../src/lib/notifications/preference-queries";

const AUTHOR_ID = "pq-test-author";
const AUTHOR_ID_2 = "pq-test-author-2";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(AUTHOR_ID, 830001, "pq-user-1"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(AUTHOR_ID_2, 830002, "pq-user-2"),
  ]);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM notification_preferences WHERE author_id IN (?, ?)",
    ).bind(AUTHOR_ID, AUTHOR_ID_2),
  ]);
});

// ---------------------------------------------------------------------------
// DEFAULT_PREFERENCES
// ---------------------------------------------------------------------------

describe("DEFAULT_PREFERENCES", () => {
  it("matches D-08 defaults exactly", () => {
    expect(DEFAULT_PREFERENCES.masterEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.auditFailEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.auditErrorEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.auditWarnEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.auditPassEnabled).toBe(false); // chatty — opt-in
    expect(DEFAULT_PREFERENCES.revokeVersionEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.revokePluginEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.reportFiledEnabled).toBe(false); // opt-in
    expect(DEFAULT_PREFERENCES.auditFailMode).toBe("immediate");
    expect(DEFAULT_PREFERENCES.emailOverride).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPreferencesForAuthor
// ---------------------------------------------------------------------------

describe("getPreferencesForAuthor", () => {
  it("returns default prefs and creates the row on first call", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(prefs.masterEnabled).toBe(true);
    expect(prefs.auditFailEnabled).toBe(true);
    expect(prefs.auditPassEnabled).toBe(false);
    expect(prefs.reportFiledEnabled).toBe(false);
    expect(prefs.auditFailMode).toBe("immediate");
    expect(prefs.emailOverride).toBeNull();

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM notification_preferences WHERE author_id = ?",
    )
      .bind(AUTHOR_ID)
      .first<{ c: number }>();
    expect(row!.c).toBe(1);
  });

  it("second call returns the same row (idempotent)", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(prefs.authorId).toBe(AUTHOR_ID);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM notification_preferences WHERE author_id = ?",
    )
      .bind(AUTHOR_ID)
      .first<{ c: number }>();
    expect(row!.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// upsertPreferences
// ---------------------------------------------------------------------------

describe("upsertPreferences", () => {
  it("updates allow-listed fields", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    await upsertPreferences(env.DB, AUTHOR_ID, {
      auditPassEnabled: true,
      auditPassMode: "daily_digest",
    });
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(prefs.auditPassEnabled).toBe(true);
    expect(prefs.auditPassMode).toBe("daily_digest");
  });

  it("ignores unknown keys (allow-list guard)", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    // Pass a key that isn't in the allow-list. Cast to the broader shape
    // so the test compiles; the runtime guard is the behaviour we care about.
    await upsertPreferences(
      env.DB,
      AUTHOR_ID,
      { author_id: "different" } as unknown as Record<string, unknown>,
    );
    const row = await env.DB.prepare(
      "SELECT author_id FROM notification_preferences WHERE author_id = ?",
    )
      .bind(AUTHOR_ID)
      .first<{ author_id: string }>();
    expect(row!.author_id).toBe(AUTHOR_ID); // unchanged
  });

  it("updates email_override", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    await upsertPreferences(env.DB, AUTHOR_ID, {
      emailOverride: "override@example.com",
    });
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(prefs.emailOverride).toBe("override@example.com");
  });

  it("updates master_enabled", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    await upsertPreferences(env.DB, AUTHOR_ID, { masterEnabled: false });
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(prefs.masterEnabled).toBe(false);
  });

  it("does nothing when the update object is empty", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    await upsertPreferences(env.DB, AUTHOR_ID, {});
    // No throw, row still exists
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(prefs.authorId).toBe(AUTHOR_ID);
  });
});

// ---------------------------------------------------------------------------
// isEventEnabled
// ---------------------------------------------------------------------------

describe("isEventEnabled", () => {
  it("returns true when master_enabled and the event is enabled", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(isEventEnabled(prefs, "audit_fail")).toBe(true);
  });

  it("returns false when master_enabled is false", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    const withMasterOff = { ...prefs, masterEnabled: false };
    expect(isEventEnabled(withMasterOff, "audit_fail")).toBe(false);
  });

  it("returns false for audit_pass by default (opt-in)", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(isEventEnabled(prefs, "audit_pass")).toBe(false);
  });

  it("returns false for report_filed by default (opt-in)", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(isEventEnabled(prefs, "report_filed")).toBe(false);
  });

  it("test_send is always allowed (bypasses master)", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    const withMasterOff = { ...prefs, masterEnabled: false };
    expect(isEventEnabled(withMasterOff, "test_send")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDeliveryMode
// ---------------------------------------------------------------------------

describe("getDeliveryMode", () => {
  it("returns 'immediate' by default", async () => {
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(getDeliveryMode(prefs, "audit_fail")).toBe("immediate");
  });

  it("returns updated mode after upsert", async () => {
    await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    await upsertPreferences(env.DB, AUTHOR_ID, {
      auditFailMode: "daily_digest",
    });
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_ID);
    expect(getDeliveryMode(prefs, "audit_fail")).toBe("daily_digest");
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveEmail
// ---------------------------------------------------------------------------

describe("resolveEffectiveEmail", () => {
  it("returns author.email when no override set", () => {
    const result = resolveEffectiveEmail(
      { email: "a@b.co", emailBouncedAt: null },
      { emailOverride: null },
    );
    expect(result).toBe("a@b.co");
  });

  it("prefers emailOverride over author.email", () => {
    const result = resolveEffectiveEmail(
      { email: "a@b.co", emailBouncedAt: null },
      { emailOverride: "c@d.co" },
    );
    expect(result).toBe("c@d.co");
  });

  it("returns null when emailBouncedAt is set (D-22)", () => {
    const result = resolveEffectiveEmail(
      { email: "a@b.co", emailBouncedAt: "2026-04-08T10:00:00Z" },
      { emailOverride: null },
    );
    expect(result).toBeNull();
  });

  it("returns null when no email available", () => {
    const result = resolveEffectiveEmail(
      { email: null, emailBouncedAt: null },
      { emailOverride: null },
    );
    expect(result).toBeNull();
  });

  it("rejects CRLF-injected addresses (T-03 mitigation)", () => {
    const result = resolveEffectiveEmail(
      { email: "bad\r\ninjected@x.co", emailBouncedAt: null },
      { emailOverride: null },
    );
    expect(result).toBeNull();
  });

  it("rejects override longer than 320 chars", () => {
    const longEmail = "a".repeat(321) + "@x.co";
    const result = resolveEffectiveEmail(
      { email: null, emailBouncedAt: null },
      { emailOverride: longEmail },
    );
    expect(result).toBeNull();
  });

  it("rejects override missing @", () => {
    const result = resolveEffectiveEmail(
      { email: null, emailBouncedAt: null },
      { emailOverride: "not-an-email" },
    );
    expect(result).toBeNull();
  });
});
