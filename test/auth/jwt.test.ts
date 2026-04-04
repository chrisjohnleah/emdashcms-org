import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
} from "../../src/lib/auth/jwt";

describe("JWT sign/verify", () => {
  it("createSessionToken returns a string JWT", async () => {
    const token = await createSessionToken(12345, "alice");
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("verifySessionToken returns payload with correct claims", async () => {
    const token = await createSessionToken(12345, "alice");
    const payload = await verifySessionToken(token);
    expect(payload.sub).toBe("12345");
    expect(payload.username).toBe("alice");
  });

  it("round-trip preserves original claims", async () => {
    const token = await createSessionToken(67890, "bob");
    const payload = await verifySessionToken(token);
    expect(payload.sub).toBe("67890");
    expect(payload.username).toBe("bob");
  });

  it("rejects tampered tokens", async () => {
    const token = await createSessionToken(12345, "alice");
    const tampered = token.slice(0, -5) + "XXXXX";
    await expect(verifySessionToken(tampered)).rejects.toThrow();
  });

  it("rejects garbage input", async () => {
    await expect(verifySessionToken("not.a.jwt")).rejects.toThrow();
  });
});
