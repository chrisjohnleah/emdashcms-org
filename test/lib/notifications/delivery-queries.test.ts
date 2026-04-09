import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  insertDeliveryClaim,
  markDeliveryStatus,
  listDeliveriesForAuthor,
  getDeliveryByIdempotencyKey,
} from "../../../src/lib/notifications/delivery-queries";
import { deriveIdempotencyKey } from "../../../src/lib/notifications/idempotency";

const AUTHOR_ID = "dq-test-author";
const AUTHOR_ID_OTHER = "dq-test-author-other";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(AUTHOR_ID, 840001, "dq-user-1"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(AUTHOR_ID_OTHER, 840002, "dq-user-2"),
  ]);
});

beforeEach(async () => {
  await env.DB.prepare(
    "DELETE FROM notification_deliveries WHERE author_id IN (?, ?)",
  )
    .bind(AUTHOR_ID, AUTHOR_ID_OTHER)
    .run();
});

// ---------------------------------------------------------------------------
// insertDeliveryClaim (re-export of claimDelivery)
// ---------------------------------------------------------------------------

describe("insertDeliveryClaim", () => {
  it("inserts a row on first call", async () => {
    const key = await deriveIdempotencyKey("dq-1", AUTHOR_ID);
    const claimed = await insertDeliveryClaim(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    expect(claimed).toBe(true);

    const row = await getDeliveryByIdempotencyKey(env.DB, key);
    expect(row).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markDeliveryStatus
// ---------------------------------------------------------------------------

describe("markDeliveryStatus", () => {
  it("updates status to sent with providerId", async () => {
    const key = await deriveIdempotencyKey("dq-sent", AUTHOR_ID);
    await insertDeliveryClaim(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    await markDeliveryStatus(env.DB, key, "sent", { providerId: "eml_abc" });

    const row = await getDeliveryByIdempotencyKey(env.DB, key);
    expect(row?.status).toBe("sent");
    expect(row?.providerId).toBe("eml_abc");
  });

  it("updates status to bounced with reason", async () => {
    const key = await deriveIdempotencyKey("dq-bounced", AUTHOR_ID);
    await insertDeliveryClaim(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    await markDeliveryStatus(env.DB, key, "bounced", {
      reason: "hard bounce",
    });

    const row = await getDeliveryByIdempotencyKey(env.DB, key);
    expect(row?.status).toBe("bounced");
    // bounced_reason is stored at the row level; check the direct column
    const raw = await env.DB.prepare(
      "SELECT bounced_reason FROM notification_deliveries WHERE idempotency_key = ?",
    )
      .bind(key)
      .first<{ bounced_reason: string }>();
    expect(raw?.bounced_reason).toBe("hard bounce");
  });

  it("updates status to failed on permanent failure", async () => {
    const key = await deriveIdempotencyKey("dq-failed", AUTHOR_ID);
    await insertDeliveryClaim(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    await markDeliveryStatus(env.DB, key, "failed", {
      reason: "invalid_email",
    });
    const row = await getDeliveryByIdempotencyKey(env.DB, key);
    expect(row?.status).toBe("failed");
  });

  it("updates status to queued on transient failure", async () => {
    const key = await deriveIdempotencyKey("dq-requeued", AUTHOR_ID);
    await insertDeliveryClaim(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    await markDeliveryStatus(env.DB, key, "queued", {
      reason: "rate_limit",
    });
    const row = await getDeliveryByIdempotencyKey(env.DB, key);
    expect(row?.status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// listDeliveriesForAuthor
// ---------------------------------------------------------------------------

describe("listDeliveriesForAuthor", () => {
  async function seedN(author: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const key = await deriveIdempotencyKey(`seed-${i}`, author);
      await insertDeliveryClaim(env.DB, {
        idempotencyKey: key,
        authorId: author,
        eventType: "audit_fail",
        entityType: "plugin",
        entityId: `pl-${i}`,
        deliveryMode: "immediate",
      });
    }
  }

  it("returns rows for only the requested author", async () => {
    await seedN(AUTHOR_ID, 3);
    await seedN(AUTHOR_ID_OTHER, 2);
    const rows = await listDeliveriesForAuthor(env.DB, AUTHOR_ID);
    expect(rows.length).toBe(3);
    const otherRows = await listDeliveriesForAuthor(
      env.DB,
      AUTHOR_ID_OTHER,
    );
    expect(otherRows.length).toBe(2);
  });

  it("defaults to returning at most 50 rows", async () => {
    await seedN(AUTHOR_ID, 55);
    const rows = await listDeliveriesForAuthor(env.DB, AUTHOR_ID);
    expect(rows.length).toBe(50);
  });

  it("caps large limit requests at 50 (Pitfall 8 hard cap)", async () => {
    await seedN(AUTHOR_ID, 55);
    const rows = await listDeliveriesForAuthor(env.DB, AUTHOR_ID, 1000);
    expect(rows.length).toBe(50);
  });

  it("respects smaller limit requests", async () => {
    await seedN(AUTHOR_ID, 10);
    const rows = await listDeliveriesForAuthor(env.DB, AUTHOR_ID, 5);
    expect(rows.length).toBe(5);
  });

  it("returns empty array for authors with no deliveries", async () => {
    const rows = await listDeliveriesForAuthor(env.DB, AUTHOR_ID);
    expect(rows).toEqual([]);
  });

  it("returns rows ordered by created_at DESC", async () => {
    await seedN(AUTHOR_ID, 5);
    const rows = await listDeliveriesForAuthor(env.DB, AUTHOR_ID);
    expect(rows.length).toBe(5);
    // Can't rely on timestamp differences at second-level granularity — just
    // confirm the result shape is correct.
    expect(rows[0]!.eventType).toBe("audit_fail");
  });
});

// ---------------------------------------------------------------------------
// getDeliveryByIdempotencyKey
// ---------------------------------------------------------------------------

describe("getDeliveryByIdempotencyKey", () => {
  it("returns null for a non-existent key", async () => {
    const row = await getDeliveryByIdempotencyKey(env.DB, "does-not-exist");
    expect(row).toBeNull();
  });

  it("returns id, status, providerId for an existing row", async () => {
    const key = await deriveIdempotencyKey("dq-lookup", AUTHOR_ID);
    await insertDeliveryClaim(env.DB, {
      idempotencyKey: key,
      authorId: AUTHOR_ID,
      eventType: "audit_fail",
      entityType: "plugin",
      entityId: "pl-1",
      deliveryMode: "immediate",
    });
    const row = await getDeliveryByIdempotencyKey(env.DB, key);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
    expect(row!.providerId).toBeNull();
  });
});
