import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  deriveIdempotencyKey,
  claimDelivery,
  markSent,
  markFailed,
} from "../../../src/lib/notifications/idempotency";

const AUTHOR_ID = "idem-test-author";

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors (id, github_id, github_username)
     VALUES (?, ?, ?)`,
  )
    .bind(AUTHOR_ID, 700001, "idem-user")
    .run();
});

beforeEach(async () => {
  await env.DB.prepare(
    "DELETE FROM notification_deliveries WHERE author_id = ?",
  )
    .bind(AUTHOR_ID)
    .run();
});

// ---------------------------------------------------------------------------
// deriveIdempotencyKey
// ---------------------------------------------------------------------------

describe("deriveIdempotencyKey", () => {
  it("returns a 64-char lowercase hex string", async () => {
    const key = await deriveIdempotencyKey("evt-1", AUTHOR_ID);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await deriveIdempotencyKey("evt-1", AUTHOR_ID);
    const b = await deriveIdempotencyKey("evt-1", AUTHOR_ID);
    expect(a).toBe(b);
  });

  it("produces distinct keys for different eventIds", async () => {
    const a = await deriveIdempotencyKey("evt-1", AUTHOR_ID);
    const b = await deriveIdempotencyKey("evt-2", AUTHOR_ID);
    expect(a).not.toBe(b);
  });

  it("produces distinct keys for different recipients", async () => {
    const a = await deriveIdempotencyKey("evt-1", "author-a");
    const b = await deriveIdempotencyKey("evt-1", "author-b");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// claimDelivery (INSERT OR IGNORE semantics)
// ---------------------------------------------------------------------------

describe("claimDelivery", () => {
  it("first call returns true and inserts a row", async () => {
    const key = await deriveIdempotencyKey("evt-claim-1", AUTHOR_ID);
    const claimed = await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    expect(claimed).toBe(true);

    const row = await env.DB.prepare(
      "SELECT status, attempt_count FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ status: string; attempt_count: number }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
    expect(row!.attempt_count).toBe(0);
  });

  it("second call with same key returns false and row count stays at 1", async () => {
    const key = await deriveIdempotencyKey("evt-claim-dup", AUTHOR_ID);
    await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    const second = await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    expect(second).toBe(false);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it("supports entityId null for test_send", async () => {
    const key = await deriveIdempotencyKey("evt-test-send-1", AUTHOR_ID);
    const claimed = await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "test_send",
      entityType: "none",
      entityId: null,
      deliveryMode: "immediate",
    });
    expect(claimed).toBe(true);
  });

  it("stores delivery_mode as provided", async () => {
    const key = await deriveIdempotencyKey("evt-mode-1", AUTHOR_ID);
    await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_warn",
      entityType: "plugin",
      entityId: "pl-warn",
      deliveryMode: "daily_digest",
    });
    const row = await env.DB.prepare(
      "SELECT delivery_mode FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ delivery_mode: string }>();
    expect(row!.delivery_mode).toBe("daily_digest");
  });
});

// ---------------------------------------------------------------------------
// markSent / markFailed
// ---------------------------------------------------------------------------

describe("markSent", () => {
  it("updates status, provider_id, and increments attempt_count", async () => {
    const key = await deriveIdempotencyKey("evt-send-1", AUTHOR_ID);
    await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });

    await markSent(env.DB, key, "eml_xyz_789");

    const row = await env.DB.prepare(
      "SELECT status, provider_id, attempt_count FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{
        status: string;
        provider_id: string;
        attempt_count: number;
      }>();
    expect(row!.status).toBe("sent");
    expect(row!.provider_id).toBe("eml_xyz_789");
    expect(row!.attempt_count).toBe(1);
  });
});

describe("markFailed", () => {
  it("transient=true sets status back to queued and records reason", async () => {
    const key = await deriveIdempotencyKey("evt-fail-transient", AUTHOR_ID);
    await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });

    await markFailed(env.DB, key, "rate_limit_exceeded", true);

    const row = await env.DB.prepare(
      "SELECT status, bounced_reason, attempt_count FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{
        status: string;
        bounced_reason: string;
        attempt_count: number;
      }>();
    expect(row!.status).toBe("queued");
    expect(row!.bounced_reason).toBe("rate_limit_exceeded");
    expect(row!.attempt_count).toBe(1);
  });

  it("transient=false sets status to failed", async () => {
    const key = await deriveIdempotencyKey("evt-fail-permanent", AUTHOR_ID);
    await claimDelivery(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });

    await markFailed(env.DB, key, "invalid_email_address", false);

    const row = await env.DB.prepare(
      "SELECT status, bounced_reason FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ status: string; bounced_reason: string }>();
    expect(row!.status).toBe("failed");
    expect(row!.bounced_reason).toBe("invalid_email_address");
  });
});
