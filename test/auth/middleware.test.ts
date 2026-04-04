import { describe, it, expect } from "vitest";
import {
  isProtectedRoute,
  PROTECTED_PATTERNS,
} from "../../src/lib/auth/protected-routes";

describe("isProtectedRoute", () => {
  describe("write endpoints require authentication", () => {
    it("POST /api/v1/plugins is protected", () => {
      expect(isProtectedRoute("/api/v1/plugins", "POST")).toBe(true);
    });

    it("PUT /api/v1/plugins/my-plugin is protected", () => {
      expect(isProtectedRoute("/api/v1/plugins/my-plugin", "PUT")).toBe(true);
    });

    it("DELETE /api/v1/plugins/my-plugin is protected", () => {
      expect(isProtectedRoute("/api/v1/plugins/my-plugin", "DELETE")).toBe(
        true,
      );
    });

    it("PATCH /api/v1/plugins/my-plugin is protected", () => {
      expect(isProtectedRoute("/api/v1/plugins/my-plugin", "PATCH")).toBe(
        true,
      );
    });

    it("POST /api/v1/themes is protected", () => {
      expect(isProtectedRoute("/api/v1/themes", "POST")).toBe(true);
    });

    it("PUT /api/v1/plugins/my-plugin/versions is protected", () => {
      expect(
        isProtectedRoute("/api/v1/plugins/my-plugin/versions", "PUT"),
      ).toBe(true);
    });
  });

  describe("read endpoints are public", () => {
    it("GET /api/v1/plugins is NOT protected", () => {
      expect(isProtectedRoute("/api/v1/plugins", "GET")).toBe(false);
    });

    it("GET /api/v1/themes is NOT protected", () => {
      expect(isProtectedRoute("/api/v1/themes", "GET")).toBe(false);
    });
  });

  describe("dashboard requires authentication", () => {
    it("GET /dashboard is protected", () => {
      expect(isProtectedRoute("/dashboard", "GET")).toBe(true);
    });

    it("GET /dashboard/plugins is protected", () => {
      expect(isProtectedRoute("/dashboard/plugins", "GET")).toBe(true);
    });
  });

  describe("public routes are not protected", () => {
    it("GET /api/v1/auth/github is NOT protected", () => {
      expect(isProtectedRoute("/api/v1/auth/github", "GET")).toBe(false);
    });

    it("GET / is NOT protected", () => {
      expect(isProtectedRoute("/", "GET")).toBe(false);
    });
  });

  it("exports PROTECTED_PATTERNS array", () => {
    expect(Array.isArray(PROTECTED_PATTERNS)).toBe(true);
    expect(PROTECTED_PATTERNS.length).toBeGreaterThan(0);
  });
});
