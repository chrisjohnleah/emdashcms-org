/**
 * Wire-contract snapshot for the four read endpoints that surface
 * author identity. This test is the lock for Phase 23 (Member Identity
 * Model Cleanup): it MUST pass on `main` BEFORE any rename lands in
 * 23-02 / 23-03, and MUST keep passing on every commit during the
 * refactor.
 *
 * If this test fails after a rename, the refactor leaked into the wire
 * contract — `MarketplaceClient` consumers (upstream EmDash CMS core)
 * read these field names directly. Renaming `author` → `member` (or
 * `name` → `username` inside the author object) would silently break
 * every downstream caller. Catching it here is the primary safeguard
 * for MEMB-07 ("no API response shape change").
 *
 * Field inventory cross-referenced against the ROADMAP-locked input
 * list (the set we *verify*, not the set we *assume present*):
 *   - `author` (object)         → PRESENT on all four endpoints
 *   - `author_id` (flat)        → ABSENT (asserted not present)
 *   - `authors[].id`            → ABSENT (no `authors[]` array)
 *   - `reporter_author_id`      → ABSENT (only on /api/v1/admin/reports/*)
 *   - `resolved_by_author_id`   → ABSENT (only on /api/v1/admin/reports/*)
 *
 * Implementation note: this test runs against the query+mapper pipeline
 * that backs the four GET handlers. Each handler is a pure pass-through
 * (`return jsonResponse(result)`), so pinning the mapper output is
 * equivalent to pinning the wire shape. This mirrors the established
 * pattern in test/api/plugins.test.ts and test/api/themes.test.ts.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  searchPlugins,
  getPluginDetail,
  searchThemes,
  getThemeDetail,
} from "../../src/lib/db/queries";

beforeAll(async () => {
  // Each test file runs in its own isolate (cloudflare:test pool), so a
  // clean slate here does not interfere with other suites. Mirror the
  // delete-then-seed pattern from test/api/plugins.test.ts.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM installs"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB
    .prepare(
      "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "snap-author-1",
      9001,
      "snap-alice",
      "https://avatars.githubusercontent.com/u/9001",
      1,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    )
    .run();

  // Plugin row — column list matches test/api/plugins.test.ts. icon_key
  // is null so the snapshot also pins `hasIcon: false` and `iconUrl: null`
  // as the defaults consumers see for a fresh plugin.
  await env.DB
    .prepare(
      "INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "snap-plugin",
      "snap-author-1",
      "Snap Plugin",
      "Plugin used by the contract-snapshot test only.",
      "content",
      "[]",
      "[]",
      null,
      null,
      null,
      "MIT",
      0,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    )
    .run();

  // Published version so getPluginDetail returns the row (it filters to
  // status IN ('published','flagged')). bundle_key is NOT NULL.
  await env.DB
    .prepare(
      "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "snap-version-1",
      "snap-plugin",
      "1.0.0",
      "published",
      "bundles/snap-plugin/1.0.0.tar.gz",
      '{"id":"snap-plugin","version":"1.0.0","capabilities":[]}',
      1,
      1024,
      4096,
      "sha256:deadbeef",
      "Initial snapshot fixture.",
      "# Snap Plugin",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    )
    .run();

  // Theme row — match the column list in test/api/themes.test.ts (which
  // includes npm_package, preview_url, homepage_url). repository_url is
  // set because both searchThemes and getThemeDetail filter to themes
  // with `repository_url OR npm_package` ("only show themes that have
  // something to install"). thumbnail_key is null so the snapshot also
  // pins `hasThumbnail: false` and `thumbnailUrl: null` as defaults.
  await env.DB
    .prepare(
      "INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "snap-theme",
      "snap-author-1",
      "Snap Theme",
      "Theme used by the contract-snapshot test only.",
      "[]",
      "https://github.com/snap-alice/snap-theme",
      null,
      null,
      null,
      null,
      null,
      "MIT",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    )
    .run();
});

describe("contract snapshot — wire-contract lock for Phase 23", () => {
  // Every assertion in this suite compares against the SAME literal
  // shape, so every rename collision lights up in one place.
  const expectedAuthorShape = {
    name: "snap-alice",
    verified: true,
    avatarUrl: "https://avatars.githubusercontent.com/u/9001",
  };

  it("GET /api/v1/plugins emits author as { name, verified, avatarUrl } and no author_id", async () => {
    const result = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });
    const item = result.items.find((p) => p.id === "snap-plugin");
    expect(item).toBeDefined();
    expect(item!.author).toEqual(expectedAuthorShape);

    // Absence assertions — every ROADMAP-listed-but-not-shipped field.
    expect(item).not.toHaveProperty("author_id");
    expect(item!.author).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("authors");
    expect(item).not.toHaveProperty("authors");
    expect(item).not.toHaveProperty("reporter_author_id");
    expect(item).not.toHaveProperty("resolved_by_author_id");
  });

  it("GET /api/v1/plugins/:id emits author as { name, verified, avatarUrl } and no author_id", async () => {
    const detail = await getPluginDetail(env.DB, "snap-plugin");
    expect(detail).not.toBeNull();
    expect(detail!.author).toEqual(expectedAuthorShape);

    expect(detail).not.toHaveProperty("author_id");
    expect(detail!.author).not.toHaveProperty("id");
    expect(detail).not.toHaveProperty("authors");
    expect(detail).not.toHaveProperty("reporter_author_id");
    expect(detail).not.toHaveProperty("resolved_by_author_id");
  });

  it("GET /api/v1/themes emits author as { name, verified, avatarUrl } and no author_id", async () => {
    const result = await searchThemes(env.DB, {
      query: "",
      category: null,
      keyword: null,
      sort: "created",
      cursor: null,
      limit: 20,
    });
    const item = result.items.find((t) => t.id === "snap-theme");
    expect(item).toBeDefined();
    expect(item!.author).toEqual(expectedAuthorShape);

    expect(item).not.toHaveProperty("author_id");
    expect(item!.author).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("authors");
    expect(item).not.toHaveProperty("authors");
    expect(item).not.toHaveProperty("reporter_author_id");
    expect(item).not.toHaveProperty("resolved_by_author_id");
  });

  it("GET /api/v1/themes/:id emits author as { name, verified, avatarUrl } and no author_id", async () => {
    const detail = await getThemeDetail(env.DB, "snap-theme");
    expect(detail).not.toBeNull();
    expect(detail!.author).toEqual(expectedAuthorShape);

    expect(detail).not.toHaveProperty("author_id");
    expect(detail!.author).not.toHaveProperty("id");
    expect(detail).not.toHaveProperty("authors");
    expect(detail).not.toHaveProperty("reporter_author_id");
    expect(detail).not.toHaveProperty("resolved_by_author_id");
  });
});
