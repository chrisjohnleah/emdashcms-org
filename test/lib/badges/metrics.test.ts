/**
 * Phase 22 lifecycle metric — focused regression tests for the four-state
 * mapping (D-04) plus the unknown fallback, and a one-D1-read invariant
 * pin on `getBadgeData` (D-06).
 *
 * The pre-existing combined suite at `test/api/badges.test.ts` covers
 * the other five metric builders and the cache/handler/embed-panel
 * surfaces. This file exists per the 22-03 plan to keep the lifecycle
 * regressions discoverable from `test/lib/badges/` alongside future
 * library-level extensions.
 */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { BADGE_COLORS } from "../../../src/lib/badges/render";
import {
  buildBadgeContent,
  getBadgeData,
  type BadgeData,
} from "../../../src/lib/badges/metrics";

// ---------------------------------------------------------------------------
// Seed: one active plugin, one deprecated, one unlisted, one revoked. Each
// covers a single state of the D-04 precedence ladder. The deprecated +
// revoked combo (revoked overrides deprecated) is exercised at the unit
// layer via buildBadgeContent because seeding two columns simultaneously
// would conflate the two builder cases under the same row.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB.prepare(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "lifecycle-author",
      9101,
      "lifecycle-dev",
      "https://avatars.githubusercontent.com/u/9101",
      1,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    )
    .run();

  // Active plugin — deprecated_at IS NULL, unlisted_at IS NULL.
  await env.DB.prepare(
    "INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, status, deprecated_at, unlisted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "lifecycle-active",
      "lifecycle-author",
      "Lifecycle Active Plugin",
      "Active plugin used to assert the lifecycle=active builder branch.",
      "content",
      "[]",
      "[]",
      null,
      null,
      null,
      "MIT",
      0,
      "active",
      null,
      null,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    )
    .run();

  // Deprecated plugin — deprecated_at NOT NULL.
  await env.DB.prepare(
    "INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, status, deprecated_at, unlisted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "lifecycle-deprecated",
      "lifecycle-author",
      "Lifecycle Deprecated Plugin",
      "Deprecated plugin used to assert the lifecycle=deprecated branch.",
      "content",
      "[]",
      "[]",
      null,
      null,
      null,
      "MIT",
      0,
      "active",
      "2026-04-15T10:00:00Z",
      null,
      "2026-04-01T00:00:00Z",
      "2026-04-15T10:00:00Z",
    )
    .run();
});

// ---------------------------------------------------------------------------
// buildBadgeContent — D-04 four-state mapping
// ---------------------------------------------------------------------------

const baseLifecycleData = (overrides: Partial<BadgeData> = {}): BadgeData => ({
  pluginExists: true,
  pluginStatus: "active",
  installsCount: 0,
  latestVersion: null,
  latestVersionStatus: null,
  latestAuditVerdict: null,
  latestAuditModel: null,
  minEmDashVersion: null,
  deprecatedAt: null,
  unlistedAt: null,
  ...overrides,
});

describe("buildBadgeContent('lifecycle')", () => {
  it("returns unknown/muted for an unknown plugin (Test 1)", () => {
    const out = buildBadgeContent(
      "lifecycle",
      baseLifecycleData({ pluginExists: false, pluginStatus: null }),
    );
    expect(out).toEqual({
      label: "lifecycle",
      value: "unknown",
      color: BADGE_COLORS.muted,
    });
  });

  it("returns revoked/danger when pluginStatus is revoked even if deprecated_at is set (Test 2)", () => {
    const out = buildBadgeContent(
      "lifecycle",
      baseLifecycleData({
        pluginStatus: "revoked",
        deprecatedAt: "2026-04-01T00:00:00Z",
        unlistedAt: null,
      }),
    );
    expect(out).toEqual({
      label: "lifecycle",
      value: "revoked",
      color: BADGE_COLORS.danger,
    });
  });

  it("returns deprecated/warn when deprecated_at is set and not revoked (Test 3)", () => {
    const out = buildBadgeContent(
      "lifecycle",
      baseLifecycleData({
        pluginStatus: "active",
        deprecatedAt: "2026-04-01T00:00:00Z",
        unlistedAt: null,
      }),
    );
    expect(out).toEqual({
      label: "lifecycle",
      value: "deprecated",
      color: BADGE_COLORS.warn,
    });
  });

  it("returns unlisted/muted when unlisted_at is set and deprecated_at is null (Test 4)", () => {
    const out = buildBadgeContent(
      "lifecycle",
      baseLifecycleData({
        pluginStatus: "active",
        deprecatedAt: null,
        unlistedAt: "2026-04-01T00:00:00Z",
      }),
    );
    expect(out).toEqual({
      label: "lifecycle",
      value: "unlisted",
      color: BADGE_COLORS.muted,
    });
  });

  it("returns active/success when neither lifecycle column is set (Test 5)", () => {
    const out = buildBadgeContent(
      "lifecycle",
      baseLifecycleData({
        pluginStatus: "active",
        deprecatedAt: null,
        unlistedAt: null,
      }),
    );
    expect(out).toEqual({
      label: "lifecycle",
      value: "active",
      color: BADGE_COLORS.success,
    });
  });

  it("prefers deprecated over unlisted when both columns are set (precedence ladder)", () => {
    const out = buildBadgeContent(
      "lifecycle",
      baseLifecycleData({
        pluginStatus: "active",
        deprecatedAt: "2026-04-01T00:00:00Z",
        unlistedAt: "2026-04-02T00:00:00Z",
      }),
    );
    expect(out.value).toBe("deprecated");
  });
});

// ---------------------------------------------------------------------------
// getBadgeData — reads deprecated_at / unlisted_at in a single prepared
// statement (D-06 one-D1-read budget pinned)
// ---------------------------------------------------------------------------

describe("getBadgeData lifecycle columns", () => {
  it("hydrates deprecatedAt and unlistedAt for an active plugin (both null)", async () => {
    const data = await getBadgeData(env.DB, "lifecycle-active");
    expect(data.pluginExists).toBe(true);
    expect(data.deprecatedAt).toBeNull();
    expect(data.unlistedAt).toBeNull();
  });

  it("hydrates deprecatedAt for a deprecated plugin (Test 6)", async () => {
    const data = await getBadgeData(env.DB, "lifecycle-deprecated");
    expect(data.pluginExists).toBe(true);
    expect(data.deprecatedAt).toBe("2026-04-15T10:00:00Z");
    expect(data.unlistedAt).toBeNull();
  });

  it("returns null lifecycle fields for an unknown plugin id", async () => {
    const data = await getBadgeData(env.DB, "lifecycle-does-not-exist");
    expect(data.pluginExists).toBe(false);
    expect(data.deprecatedAt).toBeNull();
    expect(data.unlistedAt).toBeNull();
  });

  it("executes exactly one db.prepare call when reading lifecycle columns (D-06)", async () => {
    // Pin the one-D1-read budget — adding deprecated_at / unlisted_at to
    // the existing top-level SELECT must NOT introduce a second prepare
    // call. If a future change replaces them with subqueries or a
    // separate query, this assertion fails.
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();
    await getBadgeData(env.DB, "lifecycle-deprecated");
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });
});
