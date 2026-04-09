/**
 * Integration tests for the dashboard notification settings handlers.
 *
 * The Astro page itself is a thin wrapper that dispatches POSTs to the
 * helpers in `src/lib/notifications/settings-handlers.ts`; the vitest
 * pool harness doesn't render Astro routes end-to-end, so these tests
 * exercise the helpers directly (same pattern as
 * `test/api/reports-notifications.test.ts`).
 *
 * Covers T-17 (form dispatch CSRF carried by middleware — verified by
 * the page's reliance on the `_action` form field rather than a JSON
 * PATCH), T-18 (test-send CSRF via same form path), T-19 (session-scoped
 * authorId, allow-list on updatable fields), T-20 (XSS guarded by Astro
 * default escaping — asserted by grep in the acceptance criteria), T-21
 * (never leaks another user's email), T-22 (test-send rate limit).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from "vitest";
import { env } from "cloudflare:test";

import {
  handleSavePreferences,
  handleSaveEmail,
  handleClearEmailOverride,
  handleTestSend,
  formDataFromRecord,
  hasAuthorBounced,
  validateEmailOverride,
  TEST_SEND_COOLDOWN_SECONDS,
} from "../../src/lib/notifications/settings-handlers";
import {
  getPreferencesForAuthor,
} from "../../src/lib/notifications/preference-queries";
import {
  listDeliveriesForAuthor,
} from "../../src/lib/notifications/delivery-queries";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHOR_A_ID = "ds-author-a";
const AUTHOR_B_ID = "ds-author-b";
const BOUNCED_AUTHOR_ID = "ds-author-bounced";
const NO_EMAIL_AUTHOR_ID = "ds-author-no-email";

const AUTHOR_A_EMAIL = "publisher-a@example.com";
const AUTHOR_B_EMAIL = "publisher-b@example.com";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9100001, 'ds-a', ?)`,
    ).bind(AUTHOR_A_ID, AUTHOR_A_EMAIL),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9100002, 'ds-b', ?)`,
    ).bind(AUTHOR_B_ID, AUTHOR_B_EMAIL),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email, email_bounced_at)
       VALUES (?, 9100003, 'ds-bounce', 'bounced@example.com', '2026-04-01T00:00:00Z')`,
    ).bind(BOUNCED_AUTHOR_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9100004, 'ds-noemail', NULL)`,
    ).bind(NO_EMAIL_AUTHOR_ID),
  ]);
});

beforeEach(async () => {
  // Reset preference rows + delivery history to a deterministic state
  // before every test. We delete rather than truncate so foreign keys
  // and indexes stay untouched.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM notification_preferences WHERE author_id IN (?, ?, ?, ?)",
    ).bind(AUTHOR_A_ID, AUTHOR_B_ID, BOUNCED_AUTHOR_ID, NO_EMAIL_AUTHOR_ID),
    env.DB.prepare(
      "DELETE FROM notification_deliveries WHERE author_id IN (?, ?, ?, ?)",
    ).bind(AUTHOR_A_ID, AUTHOR_B_ID, BOUNCED_AUTHOR_ID, NO_EMAIL_AUTHOR_ID),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// handleSavePreferences
// ---------------------------------------------------------------------------

describe("handleSavePreferences", () => {
  it("persists the full preference form on first save", async () => {
    const form = formDataFromRecord({
      masterEnabled: true,
      auditFailEnabled: true,
      auditFailMode: "immediate",
      auditPassEnabled: true,
      auditPassMode: "daily_digest",
      reportFiledEnabled: true,
      reportFiledMode: "daily_digest",
    });

    const result = await handleSavePreferences(env.DB, AUTHOR_A_ID, form);

    expect(result.type).toBe("success");
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    expect(prefs.masterEnabled).toBe(true);
    expect(prefs.auditPassEnabled).toBe(true);
    expect(prefs.auditPassMode).toBe("daily_digest");
    expect(prefs.reportFiledEnabled).toBe(true);
    expect(prefs.reportFiledMode).toBe("daily_digest");
    // Fields absent from the form → treated as unchecked
    expect(prefs.auditErrorEnabled).toBe(false);
    expect(prefs.revokePluginEnabled).toBe(false);
  });

  it("silently ignores attempts to write author_id or unknown columns", async () => {
    // Seed prefs for author A with a known emailOverride so we can
    // detect cross-contamination.
    await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({ email_override: "legit-a@example.com" }),
    );
    // Also touch author B so both rows exist.
    await handleSaveEmail(
      env.DB,
      AUTHOR_B_ID,
      formDataFromRecord({ email_override: "legit-b@example.com" }),
    );

    // Attacker POSTs as author A but tries to flip B's row.
    const attackerForm = formDataFromRecord({
      masterEnabled: true,
      author_id: AUTHOR_B_ID,
      authorId: AUTHOR_B_ID,
      email_override: "attacker@example.com",
      drop_table: "notification_preferences",
    });

    await handleSavePreferences(env.DB, AUTHOR_A_ID, attackerForm);

    const prefsA = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    const prefsB = await getPreferencesForAuthor(env.DB, AUTHOR_B_ID);
    // A's row was the only target.
    expect(prefsA.masterEnabled).toBe(true);
    // A's email override untouched by the preferences handler.
    expect(prefsA.emailOverride).toBe("legit-a@example.com");
    // B's row completely untouched.
    expect(prefsB.emailOverride).toBe("legit-b@example.com");
    expect(prefsB.masterEnabled).toBe(true); // default
  });

  it("ignores mode values that aren't in the enum", async () => {
    const form = formDataFromRecord({
      masterEnabled: true,
      auditFailEnabled: true,
      auditFailMode: "immediate",
      // Junk value — handler should leave the default untouched
      auditErrorMode: "yeet",
    });
    await handleSavePreferences(env.DB, AUTHOR_A_ID, form);
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    expect(prefs.auditErrorMode).toBe("immediate");
  });
});

// ---------------------------------------------------------------------------
// handleSaveEmail / handleClearEmailOverride
// ---------------------------------------------------------------------------

describe("handleSaveEmail", () => {
  it("accepts a valid email and persists it", async () => {
    const result = await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({ email_override: "new-a@example.com" }),
    );
    expect(result.type).toBe("success");
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    expect(prefs.emailOverride).toBe("new-a@example.com");
  });

  it("rejects a CRLF-injected email and leaves the row untouched", async () => {
    const result = await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({
        email_override: "attacker@example.com\r\nBcc: victim@example.com",
      }),
    );
    expect(result.type).toBe("error");
    const prefs = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    expect(prefs.emailOverride).toBeNull();
  });

  it("rejects an empty email", async () => {
    const result = await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({ email_override: "   " }),
    );
    expect(result.type).toBe("error");
  });

  it("rejects an email that's too long", async () => {
    const longLocal = "a".repeat(321);
    const result = await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({ email_override: `${longLocal}@example.com` }),
    );
    expect(result.type).toBe("error");
  });

  it("rejects an email missing @", async () => {
    const result = await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({ email_override: "not-an-email" }),
    );
    expect(result.type).toBe("error");
  });
});

describe("validateEmailOverride", () => {
  it("accepts a well-formed email", () => {
    expect(validateEmailOverride("user@example.com")).toBeNull();
  });

  it("rejects CRLF", () => {
    expect(validateEmailOverride("a@b.com\n")).not.toBeNull();
    expect(validateEmailOverride("a@b.com\r")).not.toBeNull();
  });
});

describe("handleClearEmailOverride", () => {
  it("clears a previously-set override", async () => {
    await handleSaveEmail(
      env.DB,
      AUTHOR_A_ID,
      formDataFromRecord({ email_override: "override@example.com" }),
    );
    const before = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    expect(before.emailOverride).toBe("override@example.com");

    const result = await handleClearEmailOverride(env.DB, AUTHOR_A_ID);
    expect(result.type).toBe("success");

    const after = await getPreferencesForAuthor(env.DB, AUTHOR_A_ID);
    expect(after.emailOverride).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleTestSend
// ---------------------------------------------------------------------------

function mockFetchOk() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "eml_test_send_ok", status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("handleTestSend", () => {
  const deps = { unosendApiKey: "un_test_api_key_for_vitest" };

  it("sends a real test email via the pipeline and records it in history", async () => {
    const fetchMock = mockFetchOk();

    const result = await handleTestSend(env.DB, AUTHOR_A_ID, deps);
    expect(result.type).toBe("success");
    expect(result.message).toContain(AUTHOR_A_EMAIL);

    // Unosend was called exactly once
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain("api.unosend.co");

    // History row was inserted with status='sent' and provider_id set
    const history = await listDeliveriesForAuthor(env.DB, AUTHOR_A_ID, 50);
    expect(history).toHaveLength(1);
    expect(history[0]!.eventType).toBe("test_send");
    expect(history[0]!.status).toBe("sent");
  });

  it("refuses to send when the author has no effective email", async () => {
    const fetchMock = mockFetchOk();
    const result = await handleTestSend(env.DB, NO_EMAIL_AUTHOR_ID, deps);
    expect(result.type).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send when the author's email has bounced", async () => {
    const fetchMock = mockFetchOk();
    const result = await handleTestSend(env.DB, BOUNCED_AUTHOR_ID, deps);
    expect(result.type).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits a second test send inside the cooldown window", async () => {
    const fetchMock = mockFetchOk();

    const first = await handleTestSend(env.DB, AUTHOR_A_ID, deps);
    expect(first.type).toBe("success");

    const second = await handleTestSend(env.DB, AUTHOR_A_ID, deps);
    expect(second.type).toBe("error");
    expect(second.message).toMatch(/recently|minute/i);

    // Fetch was invoked only once despite two handler calls
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Rate-limit window is documented as 60 seconds
    expect(TEST_SEND_COOLDOWN_SECONDS).toBe(60);
  });

  it("marks the delivery row as 'queued' on a transient Unosend error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "rate_limit_exceeded", message: "slow down" },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await handleTestSend(env.DB, AUTHOR_A_ID, deps);
    expect(result.type).toBe("error");
    const history = await listDeliveriesForAuthor(env.DB, AUTHOR_A_ID, 50);
    expect(history[0]!.status).toBe("queued");
  });

  it("marks the delivery row as 'failed' on a permanent Unosend error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "validation_error", message: "bad address" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await handleTestSend(env.DB, AUTHOR_A_ID, deps);
    expect(result.type).toBe("error");
    const history = await listDeliveriesForAuthor(env.DB, AUTHOR_A_ID, 50);
    expect(history[0]!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// hasAuthorBounced (BaseLayout global banner helper)
// ---------------------------------------------------------------------------

describe("hasAuthorBounced", () => {
  it("returns true for an author with email_bounced_at set", async () => {
    expect(await hasAuthorBounced(env.DB, BOUNCED_AUTHOR_ID)).toBe(true);
  });

  it("returns false for a clean author", async () => {
    expect(await hasAuthorBounced(env.DB, AUTHOR_A_ID)).toBe(false);
  });

  it("returns false for an unknown author id", async () => {
    expect(await hasAuthorBounced(env.DB, "nobody-here")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-21: cross-author leak check
// ---------------------------------------------------------------------------

describe("T-21 cross-author isolation", () => {
  it("A's history does not include any of B's deliveries", async () => {
    // Seed both with different queued rows
    await env.DB.prepare(
      `INSERT INTO notification_deliveries
        (id, idempotency_key, author_id, event_type, entity_type, entity_id,
         delivery_mode, status, attempt_count, created_at, last_attempt_at)
       VALUES ('dsrow-a', 'dsrow-a-key', ?, 'audit_fail', 'plugin', 'pl-a',
               'immediate', 'sent', 1,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
      .bind(AUTHOR_A_ID)
      .run();
    await env.DB.prepare(
      `INSERT INTO notification_deliveries
        (id, idempotency_key, author_id, event_type, entity_type, entity_id,
         delivery_mode, status, attempt_count, created_at, last_attempt_at)
       VALUES ('dsrow-b', 'dsrow-b-key', ?, 'revoke_plugin', 'plugin', 'pl-b',
               'immediate', 'sent', 1,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
      .bind(AUTHOR_B_ID)
      .run();

    const historyA = await listDeliveriesForAuthor(env.DB, AUTHOR_A_ID, 50);
    expect(historyA.some((h) => h.entityId === "pl-b")).toBe(false);
    expect(historyA.some((h) => h.entityId === "pl-a")).toBe(true);
  });
});
