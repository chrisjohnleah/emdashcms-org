import { describe, it, expect } from "vitest";
import { getBearerToken } from "../../src/lib/auth/session";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://emdashcms.org/api/v1/plugins", { headers });
}

describe("getBearerToken", () => {
  it("returns the token from a well-formed Authorization header", () => {
    expect(getBearerToken(req({ Authorization: "Bearer abc.def.ghi" }))).toBe(
      "abc.def.ghi",
    );
  });

  it("returns null when the header is absent", () => {
    expect(getBearerToken(req())).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    expect(getBearerToken(req({ Authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
    expect(getBearerToken(req({ Authorization: "Token foo" }))).toBeNull();
  });

  it("returns null when scheme is present but token is empty", () => {
    expect(getBearerToken(req({ Authorization: "Bearer " }))).toBeNull();
    expect(getBearerToken(req({ Authorization: "Bearer" }))).toBeNull();
  });

  it("is case-sensitive on the scheme — RFC 6750 specifies 'Bearer'", () => {
    // Some clients send 'bearer' lowercase; we accept only the canonical
    // form to keep behavior simple and explicit. If a real CLI ships
    // lowercase we can relax this — for now, fail closed.
    expect(getBearerToken(req({ Authorization: "bearer abc" }))).toBeNull();
  });
});
