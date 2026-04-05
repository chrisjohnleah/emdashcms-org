import { describe, it, expect } from "vitest";
import { verifyWebhookSignature } from "../../src/lib/github/webhook-verify";

// ---------------------------------------------------------------------------
// Helper: compute HMAC-SHA256 hex digest for test assertions
// ---------------------------------------------------------------------------

async function computeHmac(payload: string, secret: string): Promise<string> {
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

const TEST_SECRET = "test-webhook-secret-at-least-32-characters";

describe("verifyWebhookSignature", () => {
  it("returns true for a valid signature", async () => {
    const payload = '{"action":"published","release":{"tag_name":"v1.0.0"}}';
    const signature = await computeHmac(payload, TEST_SECRET);
    const result = await verifyWebhookSignature(payload, signature, TEST_SECRET);
    expect(result).toBe(true);
  });

  it("returns false for a tampered payload", async () => {
    const payload = '{"action":"published"}';
    const signature = await computeHmac(payload, TEST_SECRET);
    const tampered = '{"action":"deleted"}';
    const result = await verifyWebhookSignature(tampered, signature, TEST_SECRET);
    expect(result).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    const payload = '{"action":"published"}';
    const signature = await computeHmac(payload, TEST_SECRET);
    const result = await verifyWebhookSignature(payload, signature, "wrong-secret-value-at-least-32-chars");
    expect(result).toBe(false);
  });

  it("returns false for signature with wrong prefix", async () => {
    const payload = '{"action":"published"}';
    const validSig = await computeHmac(payload, TEST_SECRET);
    // Replace sha256= with sha1=
    const wrongPrefix = validSig.replace("sha256=", "sha1=");
    const result = await verifyWebhookSignature(payload, wrongPrefix, TEST_SECRET);
    expect(result).toBe(false);
  });

  it("returns false for length mismatch (shorter signature)", async () => {
    const payload = '{"action":"published"}';
    const result = await verifyWebhookSignature(payload, "sha256=abc", TEST_SECRET);
    expect(result).toBe(false);
  });

  it("returns false for length mismatch (longer signature)", async () => {
    const payload = '{"action":"published"}';
    const validSig = await computeHmac(payload, TEST_SECRET);
    const result = await verifyWebhookSignature(payload, validSig + "extra", TEST_SECRET);
    expect(result).toBe(false);
  });

  it("works correctly with empty payload", async () => {
    const payload = "";
    const signature = await computeHmac(payload, TEST_SECRET);
    const result = await verifyWebhookSignature(payload, signature, TEST_SECRET);
    expect(result).toBe(true);
  });

  it("does not throw on any input combination", async () => {
    // Various edge cases that should not throw
    await expect(
      verifyWebhookSignature("", "", "secret"),
    ).resolves.toBeDefined();
    await expect(
      verifyWebhookSignature("payload", "sha256=0000", "secret"),
    ).resolves.toBeDefined();
    await expect(
      verifyWebhookSignature("x", "sha256=" + "a".repeat(64), "s"),
    ).resolves.toBeDefined();
  });
});
