import { describe, it, expect, beforeAll } from "vitest";
import { createAppJwt } from "../../src/lib/github/app-jwt";

// ---------------------------------------------------------------------------
// Generate a test RSA PKCS#8 key pair using Web Crypto
// ---------------------------------------------------------------------------

let testPrivateKeyPem: string;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const privateKeyBuffer = await crypto.subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );

  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(privateKeyBuffer)),
  );
  const lines = base64.match(/.{1,64}/g)!.join("\n");
  testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
});

// ---------------------------------------------------------------------------
// Helper: decode base64url without external libs
// ---------------------------------------------------------------------------

function decodeBase64url(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

describe("createAppJwt", () => {
  it("returns a string with 3 dot-separated parts (valid JWT structure)", async () => {
    const jwt = await createAppJwt("test-app-id", testPrivateKeyPem);
    expect(typeof jwt).toBe("string");
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("JWT header has alg RS256", async () => {
    const jwt = await createAppJwt("test-app-id", testPrivateKeyPem);
    const [headerB64] = jwt.split(".");
    const header = JSON.parse(decodeBase64url(headerB64));
    expect(header.alg).toBe("RS256");
  });

  it("JWT payload has iss matching the provided appId", async () => {
    const jwt = await createAppJwt("my-custom-app-id", testPrivateKeyPem);
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(decodeBase64url(payloadB64));
    expect(payload.iss).toBe("my-custom-app-id");
  });

  it("JWT payload has iat set ~60 seconds in the past", async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await createAppJwt("test-app-id", testPrivateKeyPem);
    const after = Math.floor(Date.now() / 1000);

    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(decodeBase64url(payloadB64));

    // iat should be ~60 seconds before now (clock drift compensation)
    expect(payload.iat).toBeGreaterThanOrEqual(before - 62);
    expect(payload.iat).toBeLessThanOrEqual(after - 58);
  });

  it("JWT payload has exp set ~10 minutes from now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await createAppJwt("test-app-id", testPrivateKeyPem);
    const after = Math.floor(Date.now() / 1000);

    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(decodeBase64url(payloadB64));

    // exp should be ~600 seconds from now
    expect(payload.exp).toBeGreaterThanOrEqual(before + 598);
    expect(payload.exp).toBeLessThanOrEqual(after + 602);
  });

  it("handles PEM with escaped newlines (normalization)", async () => {
    const escapedPem = testPrivateKeyPem.replace(/\n/g, "\\n");
    const jwt = await createAppJwt("test-app-id", escapedPem);
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("rejects invalid PEM (throws error)", async () => {
    await expect(
      createAppJwt("test-app-id", "not-a-valid-pem-key"),
    ).rejects.toThrow();
  });
});
