/**
 * Tests for POST /api/v1/webhooks/unosend.
 *
 * The vitest-pool-workers harness doesn't run the Astro request pipeline,
 * so we import the route's POST handler directly and invoke it with a
 * constructed Request. The harness still provides `env.DB` so the
 * UPDATE statements run against the same in-memory D1 database the rest
 * of the suite uses.
 *
 * Coverage:
 *  - invalid signature → 401
 *  - missing signature → 401
 *  - valid hard bounce → 200 + email_bounced_at flipped
 *  - valid soft bounce → 200 + no DB write
 *  - delivery row updated when provider_id matches
 *  - unknown event type → 200 no-op
 *  - malformed JSON with valid signature → 200 (no retry storm)
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { POST } from "../../src/pages/api/v1/webhooks/unosend";

const WEBHOOK_SECRET = "test-unosend-webhook-secret-at-least-32-chars";

const AUTHOR_ID = "uw-author";
const AUTHOR_EMAIL = "uw-author@example.com";
const PROVIDER_ID = "eml_uw_test_001";
const IDEMPOTENCY_KEY = "uw-test-idem-key-".padEnd(64, "0").slice(0, 64);

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO authors (id, github_id, github_username, email, email_bounced_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).bind(AUTHOR_ID, 860001, "uw-publisher", AUTHOR_EMAIL),
  ]);
});

beforeEach(async () => {
  // Clean state for each test
  await env.DB.prepare(
    "UPDATE authors SET email = ?, email_bounced_at = NULL WHERE id = ?",
  )
    .bind(AUTHOR_EMAIL, AUTHOR_ID)
    .run();
  await env.DB.prepare(
    "DELETE FROM notification_deliveries WHERE author_id = ?",
  )
    .bind(AUTHOR_ID)
    .run();
});

// ---------------------------------------------------------------------------
// HMAC helper — matches verifyUnosendSignature exactly
// ---------------------------------------------------------------------------

async function computeSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

function buildRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature !== null) {
    headers["x-unosend-signature"] = signature;
  }
  return new Request("https://emdashcms.org/api/v1/webhooks/unosend", {
    method: "POST",
    headers,
    body,
  });
}

// Astro provides a richer context object; the unosend handler only reads
// `request`. Cast through unknown to satisfy the APIRoute signature.
function ctx(req: Request): Parameters<typeof POST>[0] {
  return { request: req } as unknown as Parameters<typeof POST>[0];
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("POST /api/v1/webhooks/unosend — signature", () => {
  it("rejects an invalid signature with 401", async () => {
    const body = JSON.stringify({
      id: "evt_1",
      type: "email.bounced",
      created_at: "2026-04-09T12:00:00Z",
      data: {
        email: AUTHOR_EMAIL,
        email_id: "eml_x",
        bounce_type: "hard",
        bounce_reason: "user unknown",
      },
    });
    const wrongSig = "sha256=" + "0".repeat(64);
    const res = await POST(ctx(buildRequest(body, wrongSig)));
    expect(res.status).toBe(401);
  });

  it("rejects a missing signature header with 401", async () => {
    const body = JSON.stringify({
      id: "evt_2",
      type: "email.bounced",
      created_at: "2026-04-09T12:00:00Z",
      data: { email: AUTHOR_EMAIL },
    });
    const res = await POST(ctx(buildRequest(body, null)));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Hard bounce → flips email_bounced_at
// ---------------------------------------------------------------------------

describe("POST /api/v1/webhooks/unosend — hard bounce", () => {
  it("sets authors.email_bounced_at on a valid hard bounce", async () => {
    const body = JSON.stringify({
      id: "evt_hard_1",
      type: "email.bounced",
      created_at: "2026-04-09T12:00:00Z",
      data: {
        email: AUTHOR_EMAIL,
        email_id: PROVIDER_ID,
        bounce_type: "hard",
        bounce_reason: "user unknown",
      },
    });
    const sig = await computeSignature(body, WEBHOOK_SECRET);
    const res = await POST(ctx(buildRequest(body, sig)));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT email_bounced_at FROM authors WHERE id = ?",
    )
      .bind(AUTHOR_ID)
      .first<{ email_bounced_at: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.email_bounced_at).not.toBeNull();
  });

  it("updates notification_deliveries.status to 'bounced' when provider_id matches", async () => {
    // Seed a delivery row that the bounce should target
    await env.DB.prepare(
      `INSERT INTO notification_deliveries
        (id, idempotency_key, author_id, event_type, entity_type, entity_id,
         delivery_mode, status, attempt_count, created_at, last_attempt_at, provider_id)
       VALUES (?, ?, ?, 'audit_fail', 'plugin', 'some-plugin',
               'immediate', 'sent', 1,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               ?)`,
    )
      .bind(
        "uw-delivery-001",
        IDEMPOTENCY_KEY,
        AUTHOR_ID,
        PROVIDER_ID,
      )
      .run();

    const body = JSON.stringify({
      id: "evt_hard_2",
      type: "email.bounced",
      created_at: "2026-04-09T12:00:00Z",
      data: {
        email: AUTHOR_EMAIL,
        email_id: PROVIDER_ID,
        bounce_type: "hard",
        bounce_reason: "mailbox full",
      },
    });
    const sig = await computeSignature(body, WEBHOOK_SECRET);
    const res = await POST(ctx(buildRequest(body, sig)));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT status, bounced_reason FROM notification_deliveries WHERE provider_id = ?",
    )
      .bind(PROVIDER_ID)
      .first<{ status: string; bounced_reason: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("bounced");
    expect(row!.bounced_reason).toBe("mailbox full");
  });
});

// ---------------------------------------------------------------------------
// Soft bounce no-op (D-23)
// ---------------------------------------------------------------------------

describe("POST /api/v1/webhooks/unosend — soft bounce", () => {
  it("acks soft bounce without flipping email_bounced_at", async () => {
    const body = JSON.stringify({
      id: "evt_soft_1",
      type: "email.bounced",
      created_at: "2026-04-09T12:00:00Z",
      data: {
        email: AUTHOR_EMAIL,
        email_id: "eml_soft",
        bounce_type: "soft",
        bounce_reason: "temporary failure",
      },
    });
    const sig = await computeSignature(body, WEBHOOK_SECRET);
    const res = await POST(ctx(buildRequest(body, sig)));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT email_bounced_at FROM authors WHERE id = ?",
    )
      .bind(AUTHOR_ID)
      .first<{ email_bounced_at: string | null }>();
    expect(row!.email_bounced_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Other event types → no-op
// ---------------------------------------------------------------------------

describe("POST /api/v1/webhooks/unosend — other event types", () => {
  it("acknowledges email.delivered with 200 and no DB writes", async () => {
    const body = JSON.stringify({
      id: "evt_delivered_1",
      type: "email.delivered",
      created_at: "2026-04-09T12:00:00Z",
      data: { email: AUTHOR_EMAIL, email_id: "eml_d" },
    });
    const sig = await computeSignature(body, WEBHOOK_SECRET);
    const res = await POST(ctx(buildRequest(body, sig)));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT email_bounced_at FROM authors WHERE id = ?",
    )
      .bind(AUTHOR_ID)
      .first<{ email_bounced_at: string | null }>();
    expect(row!.email_bounced_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON → 200 (no retry storm)
// ---------------------------------------------------------------------------

describe("POST /api/v1/webhooks/unosend — malformed payload", () => {
  it("returns 200 (not 4xx/5xx) when the body is not valid JSON", async () => {
    const body = "not json {{{";
    const sig = await computeSignature(body, WEBHOOK_SECRET);
    const res = await POST(ctx(buildRequest(body, sig)));
    // Pitfall 2 in 12-RESEARCH.md: never let a malformed body trigger a
    // Unosend retry storm. Always 200.
    expect(res.status).toBe(200);
  });

  it("returns 200 when the body is JSON but doesn't match the schema", async () => {
    const body = JSON.stringify({ totally: "wrong shape" });
    const sig = await computeSignature(body, WEBHOOK_SECRET);
    const res = await POST(ctx(buildRequest(body, sig)));
    expect(res.status).toBe(200);
  });
});
