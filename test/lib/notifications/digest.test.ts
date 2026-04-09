/**
 * Integration tests for the daily-digest Cron handler.
 *
 * The handler is triggered by the worker `scheduled` export when
 * `event.cron === '5 9 * * *'`. It queries queued digest rows, groups
 * by author, renders one aggregated email per author, sends via
 * Unosend, and flips row statuses based on the outcome.
 *
 * Coverage (per 12-03-PLAN.md Task 2 behaviour list):
 *   - Happy path: two authors, two emails, all rows marked sent
 *   - Out-of-scope rows (immediate mode) are untouched
 *   - Authors with bounced emails are skipped, rows marked 'skipped'
 *   - Transient send errors leave rows queued for the next run
 *   - Permanent send errors mark rows as failed
 *   - Provider id is captured on successful sends
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:test";
import { runDailyDigest } from "../../../src/lib/notifications/digest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHOR_A = "dg-author-a";
const AUTHOR_B = "dg-author-b";
const AUTHOR_C = "dg-author-c";
const AUTHOR_BOUNCED = "dg-author-bounced";
const AUTHOR_TRANSIENT = "dg-author-transient";
const AUTHOR_PERMANENT = "dg-author-permanent";
const AUTHOR_NO_EMAIL = "dg-author-no-email";

const PLUGIN_A = "dg-plugin-a";
const PLUGIN_B = "dg-plugin-b";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9200001, 'dg-a', 'a@example.com')`,
    ).bind(AUTHOR_A),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9200002, 'dg-b', 'b@example.com')`,
    ).bind(AUTHOR_B),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9200003, 'dg-c', 'c@example.com')`,
    ).bind(AUTHOR_C),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email, email_bounced_at)
       VALUES (?, 9200004, 'dg-bounced', 'bounced@example.com', '2026-04-01T00:00:00Z')`,
    ).bind(AUTHOR_BOUNCED),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9200005, 'dg-trans', 'trans@example.com')`,
    ).bind(AUTHOR_TRANSIENT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9200006, 'dg-perm', 'perm@example.com')`,
    ).bind(AUTHOR_PERMANENT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email)
       VALUES (?, 9200007, 'dg-noemail', NULL)`,
    ).bind(AUTHOR_NO_EMAIL),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins
        (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, 'Dig Plugin A', 'desc', '[]', '[]', 0,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_A, AUTHOR_A),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins
        (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, 'Dig Plugin B', 'desc', '[]', '[]', 0,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_B, AUTHOR_B),
  ]);
});

/**
 * Seed one delivery row. Uses `delivery_mode='daily_digest'` + the
 * supplied status + event_type, and writes an idempotency_key that
 * embeds the row id so collisions across tests are impossible.
 */
async function seedDelivery(params: {
  rowId: string;
  authorId: string;
  status?: "queued" | "sent";
  deliveryMode?: "daily_digest" | "immediate";
  eventType?: string;
  entityType?: "plugin" | "theme" | "none";
  entityId?: string | null;
}) {
  const {
    rowId,
    authorId,
    status = "queued",
    deliveryMode = "daily_digest",
    eventType = "audit_fail",
    entityType = "plugin",
    entityId = PLUGIN_A,
  } = params;
  await env.DB
    .prepare(
      `INSERT INTO notification_deliveries
        (id, idempotency_key, author_id, event_type, entity_type, entity_id,
         delivery_mode, status, attempt_count, created_at, last_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(
      rowId,
      `${rowId}-key`,
      authorId,
      eventType,
      entityType,
      entityId,
      deliveryMode,
      status,
    )
    .run();
}

async function getDeliveryStatus(rowId: string): Promise<{
  status: string;
  provider_id: string | null;
}> {
  const row = await env.DB
    .prepare(
      "SELECT status, provider_id FROM notification_deliveries WHERE id = ?",
    )
    .bind(rowId)
    .first<{ status: string; provider_id: string | null }>();
  return row ?? { status: "missing", provider_id: null };
}

beforeEach(async () => {
  await env.DB
    .prepare(
      "DELETE FROM notification_deliveries WHERE author_id IN (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      AUTHOR_A,
      AUTHOR_B,
      AUTHOR_C,
      AUTHOR_BOUNCED,
      AUTHOR_TRANSIENT,
      AUTHOR_PERMANENT,
      AUTHOR_NO_EMAIL,
    )
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDailyDigest", () => {
  it("groups queued digest rows by author and sends one email each", async () => {
    await seedDelivery({
      rowId: "dg-a1",
      authorId: AUTHOR_A,
      entityId: PLUGIN_A,
    });
    await seedDelivery({
      rowId: "dg-a2",
      authorId: AUTHOR_A,
      eventType: "audit_warn",
      entityId: PLUGIN_A,
    });
    await seedDelivery({
      rowId: "dg-a3",
      authorId: AUTHOR_A,
      eventType: "audit_error",
      entityId: PLUGIN_A,
    });
    await seedDelivery({
      rowId: "dg-b1",
      authorId: AUTHOR_B,
      entityId: PLUGIN_B,
    });
    await seedDelivery({
      rowId: "dg-b2",
      authorId: AUTHOR_B,
      eventType: "report_filed",
      entityId: PLUGIN_B,
    });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "eml_digest_ok", status: "queued" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    // Exactly one email per author
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // All five rows flipped to 'sent' with the provider id
    for (const id of ["dg-a1", "dg-a2", "dg-a3", "dg-b1", "dg-b2"]) {
      const row = await getDeliveryStatus(id);
      expect(row.status).toBe("sent");
      expect(row.provider_id).toBe("eml_digest_ok");
    }
  });

  it("does not touch immediate-mode or already-sent rows", async () => {
    await seedDelivery({
      rowId: "dg-c-imm",
      authorId: AUTHOR_C,
      deliveryMode: "immediate",
    });
    await seedDelivery({
      rowId: "dg-c-done",
      authorId: AUTHOR_C,
      status: "sent",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    expect(fetchMock).not.toHaveBeenCalled();
    const imm = await getDeliveryStatus("dg-c-imm");
    const done = await getDeliveryStatus("dg-c-done");
    expect(imm.status).toBe("queued");
    expect(done.status).toBe("sent");
  });

  it("skips authors whose email has bounced and marks their rows 'skipped'", async () => {
    await seedDelivery({
      rowId: "dg-bounced-1",
      authorId: AUTHOR_BOUNCED,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    expect(fetchMock).not.toHaveBeenCalled();
    const row = await getDeliveryStatus("dg-bounced-1");
    expect(row.status).toBe("skipped");
  });

  it("skips authors with no deliverable email", async () => {
    await seedDelivery({
      rowId: "dg-noemail-1",
      authorId: AUTHOR_NO_EMAIL,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    expect(fetchMock).not.toHaveBeenCalled();
    const row = await getDeliveryStatus("dg-noemail-1");
    expect(row.status).toBe("skipped");
  });

  it("leaves rows queued on a transient Unosend error", async () => {
    await seedDelivery({
      rowId: "dg-trans-1",
      authorId: AUTHOR_TRANSIENT,
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "service_unavailable",
            message: "upstream timeout",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await getDeliveryStatus("dg-trans-1");
    expect(row.status).toBe("queued");
  });

  it("marks rows as 'failed' on a permanent Unosend error", async () => {
    await seedDelivery({
      rowId: "dg-perm-1",
      authorId: AUTHOR_PERMANENT,
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "validation_error",
            message: "invalid address",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await getDeliveryStatus("dg-perm-1");
    expect(row.status).toBe("failed");
  });

  it("returns a no-op when there are no queued digest rows", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await runDailyDigest(env);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
