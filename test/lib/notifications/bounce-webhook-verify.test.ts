import { describe, it, expect } from "vitest";
import { verifyUnosendSignature } from "../../../src/lib/notifications/bounce-webhook-verify";

// ---------------------------------------------------------------------------
// Helper: compute `sha256=<hex>` HMAC over a payload using the same algorithm
// the receiver expects. Mirrors the pattern in test/lib/webhook-verify.test.ts.
// ---------------------------------------------------------------------------

async function computeSignature(
  payload: string,
  secret: string,
): Promise<string> {
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

const SECRET = "test-unosend-webhook-secret-at-least-32-chars";

describe("verifyUnosendSignature", () => {
  it("returns true for a valid signature", async () => {
    const payload = '{"type":"email.bounced","data":{"email":"a@b.co"}}';
    const signature = await computeSignature(payload, SECRET);
    expect(await verifyUnosendSignature(payload, signature, SECRET)).toBe(
      true,
    );
  });

  it("returns false for null signature header", async () => {
    const payload = '{"type":"email.bounced"}';
    expect(await verifyUnosendSignature(payload, null, SECRET)).toBe(false);
  });

  it("returns false when header does not start with sha256=", async () => {
    const payload = '{"type":"email.bounced"}';
    const validSig = await computeSignature(payload, SECRET);
    const wrongPrefix = validSig.replace("sha256=", "md5=");
    expect(await verifyUnosendSignature(payload, wrongPrefix, SECRET)).toBe(
      false,
    );
  });

  it("returns false when hex length is not 64", async () => {
    const payload = '{"type":"email.bounced"}';
    expect(
      await verifyUnosendSignature(payload, "sha256=deadbeef", SECRET),
    ).toBe(false);
  });

  it("returns false for a tampered payload", async () => {
    const payload = '{"type":"email.bounced"}';
    const signature = await computeSignature(payload, SECRET);
    const tampered = '{"type":"email.delivered"}';
    expect(await verifyUnosendSignature(tampered, signature, SECRET)).toBe(
      false,
    );
  });

  it("returns false for wrong secret", async () => {
    const payload = '{"type":"email.bounced"}';
    const signature = await computeSignature(payload, SECRET);
    const wrongSecret = "different-unosend-webhook-secret-at-least-32-chars";
    expect(
      await verifyUnosendSignature(payload, signature, wrongSecret),
    ).toBe(false);
  });

  it("returns false when a single byte of the hex is flipped", async () => {
    const payload = '{"type":"email.bounced"}';
    const signature = await computeSignature(payload, SECRET);
    // Flip one char in the hex portion
    const flipped =
      signature.slice(0, 10) +
      (signature.charAt(10) === "0" ? "1" : "0") +
      signature.slice(11);
    expect(await verifyUnosendSignature(payload, flipped, SECRET)).toBe(
      false,
    );
  });

  it("verifies empty body correctly when signed with the same secret", async () => {
    const payload = "";
    const signature = await computeSignature(payload, SECRET);
    expect(await verifyUnosendSignature(payload, signature, SECRET)).toBe(
      true,
    );
  });
});
