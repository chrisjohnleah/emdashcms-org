import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  processNotificationJob,
  BACKOFF_SCHEDULE_S,
} from "../../../src/lib/notifications/consumer";
import { upsertPreferences } from "../../../src/lib/notifications/preference-queries";
import type { NotificationJob } from "../../../src/types/marketplace";

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const AUTHOR_ID = "consumer-author";
const AUTHOR_EMAIL = "consumer@example.com";
const PLUGIN_ID = "consumer-plugin";
const PLUGIN_NAME = "Consumer Test Plugin";
const API_KEY = "un_test_key_consumer";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email, email_bounced_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).bind(AUTHOR_ID, 830001, "consumer-publisher", AUTHOR_EMAIL),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, AUTHOR_ID, PLUGIN_NAME, "consumer test plugin"),
  ]);
});

beforeEach(async () => {
  // Reset preferences to defaults (everything except audit_pass / report_filed enabled)
  await upsertPreferences(env.DB, AUTHOR_ID, {
    masterEnabled: true,
    auditFailEnabled: true,
    auditFailMode: "immediate",
    auditPassEnabled: true,
    auditPassMode: "immediate",
    auditWarnEnabled: true,
    auditWarnMode: "immediate",
    auditErrorEnabled: true,
    auditErrorMode: "immediate",
    revokeVersionEnabled: true,
    revokeVersionMode: "immediate",
    revokePluginEnabled: true,
    revokePluginMode: "immediate",
    reportFiledEnabled: true,
    reportFiledMode: "immediate",
    emailOverride: null,
  });
  // Reset author email + bounce flag
  await env.DB.prepare(
    "UPDATE authors SET email = ?, email_bounced_at = NULL WHERE id = ?",
  )
    .bind(AUTHOR_EMAIL, AUTHOR_ID)
    .run();
  // Clear delivery rows for this author so each test starts fresh
  await env.DB.prepare(
    "DELETE FROM notification_deliveries WHERE author_id = ?",
  )
    .bind(AUTHOR_ID)
    .run();

  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Job builder
// ---------------------------------------------------------------------------

let keyCounter = 0;
function makeKey(prefix: string): string {
  keyCounter++;
  // Pad to 64 hex chars to mimic the deriveIdempotencyKey output shape.
  const base = `${prefix}-${keyCounter}-${Date.now()}`;
  // SHA-style fake key — the consumer doesn't validate the format, just
  // requires uniqueness on INSERT OR IGNORE.
  return base.padEnd(64, "0").slice(0, 64);
}

function makeJob(
  overrides: Partial<NotificationJob> = {},
  payloadOverrides: Record<string, unknown> = {},
): NotificationJob {
  const idempotencyKey = makeKey("ck");
  return {
    eventType: "audit_fail",
    eventId: `event-${keyCounter}`,
    entityType: "plugin",
    entityId: PLUGIN_ID,
    recipientAuthorId: AUTHOR_ID,
    deliveryMode: "immediate",
    payload: {
      idempotencyKey,
      pluginName: PLUGIN_NAME,
      version: "1.2.3",
      verdict: "fail",
      riskScore: 75,
      findingCount: 4,
      ...payloadOverrides,
    },
    ...overrides,
  };
}

function mockOkFetch(id = "eml_consumer_test"): void {
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify({ id, status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function mockErrorFetch(status: number, code: string, message = "err"): void {
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

describe("BACKOFF_SCHEDULE_S", () => {
  it("is [30, 120, 600] seconds", () => {
    expect(BACKOFF_SCHEDULE_S).toEqual([30, 120, 600]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("processNotificationJob — happy path", () => {
  it("calls fetch once and marks delivery sent on 2xx response", async () => {
    mockOkFetch("eml_happy");
    const job = makeJob();
    const idempotencyKey = (job.payload as Record<string, unknown>)
      .idempotencyKey as string;

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare(
      "SELECT status, provider_id FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(idempotencyKey)
      .first<{ status: string; provider_id: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("sent");
    expect(row!.provider_id).toBe("eml_happy");
  });

  it("delivery row carries the recipient and event metadata", async () => {
    mockOkFetch();
    const job = makeJob();
    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    const row = await env.DB.prepare(
      "SELECT author_id, event_type, entity_type, entity_id FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{
        author_id: string;
        event_type: string;
        entity_type: string;
        entity_id: string;
      }>();
    expect(row!.author_id).toBe(AUTHOR_ID);
    expect(row!.event_type).toBe("audit_fail");
    expect(row!.entity_type).toBe("plugin");
    expect(row!.entity_id).toBe(PLUGIN_ID);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (claim returns false on second attempt)
// ---------------------------------------------------------------------------

describe("processNotificationJob — idempotency", () => {
  it("does not call fetch a second time when the same idempotency key replays", async () => {
    mockOkFetch("eml_first");
    const job = makeJob();

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Replay with the same key — fetch should not be called again
    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Only one delivery row exists for the key
    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;
    const result = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ n: number }>();
    expect(result!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Preference skip paths
// ---------------------------------------------------------------------------

describe("processNotificationJob — skip paths", () => {
  it("skips delivery when isEventEnabled returns false (event disabled)", async () => {
    await upsertPreferences(env.DB, AUTHOR_ID, { auditFailEnabled: false });
    const job = makeJob();

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    // Skipped delivery is recorded with a 'failed' status and reason
    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;
    const row = await env.DB.prepare(
      "SELECT status, bounced_reason FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ status: string; bounced_reason: string }>();
    expect(row!.status).toBe("failed");
    expect(row!.bounced_reason).toBe("disabled in preferences");
  });

  it("skips delivery when master_enabled is false", async () => {
    await upsertPreferences(env.DB, AUTHOR_ID, { masterEnabled: false });
    const job = makeJob();

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips delivery when recipient has no email on file", async () => {
    await env.DB.prepare(
      "UPDATE authors SET email = NULL WHERE id = ?",
    )
      .bind(AUTHOR_ID)
      .run();
    const job = makeJob();

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;
    const row = await env.DB.prepare(
      "SELECT bounced_reason FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ bounced_reason: string }>();
    expect(row!.bounced_reason).toBe("no deliverable email");
  });

  it("skips delivery when email_bounced_at is set", async () => {
    await env.DB.prepare(
      "UPDATE authors SET email_bounced_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
    )
      .bind(AUTHOR_ID)
      .run();
    const job = makeJob();

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips delivery when recipient row is missing", async () => {
    const job = makeJob({ recipientAuthorId: "nonexistent-author" });
    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Daily digest path
// ---------------------------------------------------------------------------

describe("processNotificationJob — daily digest", () => {
  it("queues a daily-digest delivery row WITHOUT calling fetch", async () => {
    const job = makeJob({ deliveryMode: "daily_digest" });
    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    const row = await env.DB.prepare(
      "SELECT status, delivery_mode FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ status: string; delivery_mode: string }>();
    expect(row!.status).toBe("queued");
    expect(row!.delivery_mode).toBe("daily_digest");
  });
});

// ---------------------------------------------------------------------------
// Unosend error classification
// ---------------------------------------------------------------------------

describe("processNotificationJob — Unosend errors", () => {
  it("rethrows UnosendTransientError so the batch loop can retry", async () => {
    mockErrorFetch(503, "service_unavailable", "down");
    const job = makeJob();

    await expect(
      processNotificationJob(job, {
        db: env.DB,
        unosendApiKey: API_KEY,
      }),
    ).rejects.toThrow(/down|service|503/i);

    // Delivery row left in 'queued' so the next retry can resume it
    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;
    const row = await env.DB.prepare(
      "SELECT status FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ status: string }>();
    expect(row!.status).toBe("queued");
  });

  it("marks delivery failed (no rethrow) on UnosendPermanentError", async () => {
    mockErrorFetch(400, "invalid_recipient", "bad email");
    const job = makeJob();

    await expect(
      processNotificationJob(job, {
        db: env.DB,
        unosendApiKey: API_KEY,
      }),
    ).resolves.toBeUndefined();

    const key = (job.payload as Record<string, unknown>).idempotencyKey as string;
    const row = await env.DB.prepare(
      "SELECT status, bounced_reason FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ status: string; bounced_reason: string }>();
    expect(row!.status).toBe("failed");
    expect(row!.bounced_reason).toContain("bad email");
  });
});

// ---------------------------------------------------------------------------
// Email override precedence
// ---------------------------------------------------------------------------

describe("processNotificationJob — email override", () => {
  it("sends to the manual override address when one is set", async () => {
    await upsertPreferences(env.DB, AUTHOR_ID, {
      emailOverride: "override@example.com",
    });
    mockOkFetch();
    const job = makeJob();

    await processNotificationJob(job, {
      db: env.DB,
      unosendApiKey: API_KEY,
    });

    const init = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["override@example.com"]);

    // Cleanup the override so the next test isn't affected
    await upsertPreferences(env.DB, AUTHOR_ID, { emailOverride: null });
  });
});
