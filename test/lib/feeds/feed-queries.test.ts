import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  listRecentPluginsForFeed,
  listRecentPluginVersionsForFeed,
  listRecentThemesForFeed,
  listPluginsByCategoryForFeed,
} from "../../../src/lib/feeds/feed-queries";

// Coverage for 14-CONTEXT.md D-08/D-09/D-10/D-11 + 14-RESEARCH.md §6.

// ---------------------------------------------------------------------------
// Seed helpers — minimal INSERT shapes for the feed query surface. Reuse of
// test/api/plugins.test.ts column list, plus short_description for D-15.
// ---------------------------------------------------------------------------

const AUTHOR_SQL =
  "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

const PLUGIN_SQL =
  "INSERT INTO plugins (id, author_id, name, description, short_description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const VERSION_SQL =
  "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const THEME_SQL =
  "INSERT INTO themes (id, author_id, name, description, short_description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function insertAuthor(id: string, login: string) {
  return env.DB.prepare(AUTHOR_SQL).bind(
    id,
    Math.abs(id.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) + 10_000,
    login,
    `https://avatars.githubusercontent.com/u/${id}`,
    1,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

interface PluginSeed {
  id: string;
  authorId: string;
  name: string;
  description?: string | null;
  shortDescription?: string | null;
  category?: string | null;
  createdAt: string;
  status?: string;
}

function insertPlugin(p: PluginSeed) {
  return env.DB.prepare(PLUGIN_SQL).bind(
    p.id,
    p.authorId,
    p.name,
    p.description ?? null,
    p.shortDescription ?? null,
    p.category ?? null,
    "[]",
    "[]",
    `https://github.com/example/${p.id}`,
    null,
    null,
    "MIT",
    0,
    p.createdAt,
    p.createdAt,
    p.status ?? "active",
  );
}

interface VersionSeed {
  id: string;
  pluginId: string;
  version: string;
  status: string;
  publishedAt: string | null;
  createdAt: string;
}

function insertVersion(v: VersionSeed) {
  return env.DB.prepare(VERSION_SQL).bind(
    v.id,
    v.pluginId,
    v.version,
    v.status,
    `bundles/${v.pluginId}/${v.version}.tar.gz`,
    "{}",
    1,
    1000,
    2000,
    "1.0.0",
    "sha256:" + "0".repeat(64),
    null,
    null,
    v.publishedAt,
    v.createdAt,
    v.createdAt,
  );
}

interface ThemeSeed {
  id: string;
  authorId: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  repositoryUrl?: string | null;
  npmPackage?: string | null;
  createdAt: string;
}

function insertTheme(t: ThemeSeed) {
  return env.DB.prepare(THEME_SQL).bind(
    t.id,
    t.authorId,
    t.name,
    t.description ?? null,
    t.shortDescription ?? null,
    "[]",
    t.repositoryUrl ?? null,
    null,
    null,
    t.npmPackage ?? null,
    null,
    null,
    "MIT",
    t.createdAt,
    t.createdAt,
  );
}

async function wipe() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM installs"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);
}

// ---------------------------------------------------------------------------

describe("listRecentPluginsForFeed", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([
      insertAuthor("fq-a1", "feed-alice"),
      insertAuthor("fq-a2", "feed-bob"),
    ]);
  });

  it("returns up to limit rows sorted by created_at DESC", async () => {
    await env.DB.batch([
      insertPlugin({
        id: "fq-p-old",
        authorId: "fq-a1",
        name: "Old",
        category: "content",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-p-mid",
        authorId: "fq-a1",
        name: "Mid",
        category: "content",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-p-new",
        authorId: "fq-a1",
        name: "New",
        category: "content",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "fq-v-old",
        pluginId: "fq-p-old",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "fq-v-mid",
        pluginId: "fq-p-mid",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertVersion({
        id: "fq-v-new",
        pluginId: "fq-p-new",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-03-01T00:00:00Z",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);

    const rows = await listRecentPluginsForFeed(env.DB, 50);
    expect(rows.map((r) => r.id)).toEqual(["fq-p-new", "fq-p-mid", "fq-p-old"]);

    const limited = await listRecentPluginsForFeed(env.DB, 2);
    expect(limited.map((r) => r.id)).toEqual(["fq-p-new", "fq-p-mid"]);
  });

  it("excludes plugins with only pending/rejected/revoked versions (active-plugin filter)", async () => {
    await env.DB.batch([
      insertPlugin({
        id: "fq-p-pending",
        authorId: "fq-a1",
        name: "Pending",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-p-rejected",
        authorId: "fq-a1",
        name: "Rejected",
        createdAt: "2026-01-02T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-p-ok",
        authorId: "fq-a1",
        name: "Ok",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "v1",
        pluginId: "fq-p-pending",
        version: "1.0.0",
        status: "pending",
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "v2",
        pluginId: "fq-p-rejected",
        version: "1.0.0",
        status: "rejected",
        publishedAt: null,
        createdAt: "2026-01-02T00:00:00Z",
      }),
      insertVersion({
        id: "v3",
        pluginId: "fq-p-ok",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-03T00:00:00Z",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    ]);

    const rows = await listRecentPluginsForFeed(env.DB, 50);
    expect(rows.map((r) => r.id)).toEqual(["fq-p-ok"]);
  });

  it("includes plugins with at least one published OR flagged version", async () => {
    await env.DB.batch([
      insertPlugin({
        id: "fq-p-flagged",
        authorId: "fq-a1",
        name: "Flagged",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-p-published",
        authorId: "fq-a1",
        name: "Published",
        createdAt: "2026-02-02T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "v-f",
        pluginId: "fq-p-flagged",
        version: "1.0.0",
        status: "flagged",
        publishedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertVersion({
        id: "v-p",
        pluginId: "fq-p-published",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-02-02T00:00:00Z",
        createdAt: "2026-02-02T00:00:00Z",
      }),
    ]);

    const rows = await listRecentPluginsForFeed(env.DB, 50);
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["fq-p-flagged", "fq-p-published"].sort(),
    );
  });

  it("joins authors and returns authorLogin column", async () => {
    await env.DB.batch([
      insertPlugin({
        id: "fq-p-author",
        authorId: "fq-a2",
        name: "Author Test",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "v-a",
        pluginId: "fq-p-author",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-03-01T00:00:00Z",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentPluginsForFeed(env.DB, 10);
    expect(rows[0]?.authorLogin).toBe("feed-bob");
  });
});

describe("listRecentPluginVersionsForFeed", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("fq-va1", "feed-author")]);
    await env.DB.batch([
      insertPlugin({
        id: "fq-pv",
        authorId: "fq-va1",
        name: "Multi Version",
        category: "content",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
  });

  it("emits one row per published/flagged version (5 versions = 3 published rows)", async () => {
    await env.DB.batch([
      insertVersion({
        id: "v1",
        pluginId: "fq-pv",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "v2",
        pluginId: "fq-pv",
        version: "1.1.0",
        status: "published",
        publishedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertVersion({
        id: "v3",
        pluginId: "fq-pv",
        version: "1.2.0",
        status: "published",
        publishedAt: "2026-03-01T00:00:00Z",
        createdAt: "2026-03-01T00:00:00Z",
      }),
      insertVersion({
        id: "v4",
        pluginId: "fq-pv",
        version: "1.3.0-pending",
        status: "pending",
        publishedAt: null,
        createdAt: "2026-03-15T00:00:00Z",
      }),
      insertVersion({
        id: "v5",
        pluginId: "fq-pv",
        version: "0.9.0",
        status: "rejected",
        publishedAt: null,
        createdAt: "2025-12-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentPluginVersionsForFeed(env.DB, 50);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(rows.every((r) => r.pluginId === "fq-pv")).toBe(true);
  });

  it("sorts by COALESCE(published_at, created_at) DESC (not pv.published_at alone)", async () => {
    await env.DB.batch([
      // Version with NULL published_at but later created_at — should sort first
      insertVersion({
        id: "v-null",
        pluginId: "fq-pv",
        version: "2.0.0",
        status: "published",
        publishedAt: null,
        createdAt: "2026-04-01T00:00:00Z",
      }),
      insertVersion({
        id: "v-old",
        pluginId: "fq-pv",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentPluginVersionsForFeed(env.DB, 50);
    expect(rows.map((r) => r.version)).toEqual(["2.0.0", "1.0.0"]);
    // publishedAt field coalesces at the row level too.
    expect(rows[0]?.publishedAt).toBe("2026-04-01T00:00:00Z");
  });

  it("excludes status=pending rows", async () => {
    await env.DB.batch([
      insertVersion({
        id: "vp",
        pluginId: "fq-pv",
        version: "0.1.0",
        status: "pending",
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentPluginVersionsForFeed(env.DB, 50);
    expect(rows).toHaveLength(0);
  });

  it("excludes status=rejected rows", async () => {
    await env.DB.batch([
      insertVersion({
        id: "vr",
        pluginId: "fq-pv",
        version: "0.1.0",
        status: "rejected",
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentPluginVersionsForFeed(env.DB, 50);
    expect(rows).toHaveLength(0);
  });

  it("excludes status=revoked rows", async () => {
    await env.DB.batch([
      insertVersion({
        id: "vx",
        pluginId: "fq-pv",
        version: "0.1.0",
        status: "revoked",
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentPluginVersionsForFeed(env.DB, 50);
    expect(rows).toHaveLength(0);
  });
});

describe("listRecentThemesForFeed", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("fq-ta", "feed-theme-author")]);
  });

  it("applies the active-theme filter (repository_url IS NOT NULL OR npm_package IS NOT NULL)", async () => {
    await env.DB.batch([
      insertTheme({
        id: "fq-t-repo",
        authorId: "fq-ta",
        name: "Repo Only",
        repositoryUrl: "https://github.com/example/repo-only",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertTheme({
        id: "fq-t-npm",
        authorId: "fq-ta",
        name: "Npm Only",
        npmPackage: "@example/theme",
        createdAt: "2026-01-02T00:00:00Z",
      }),
      insertTheme({
        id: "fq-t-none",
        authorId: "fq-ta",
        name: "No Source",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    ]);
    const rows = await listRecentThemesForFeed(env.DB, 50);
    expect(rows.map((r) => r.id).sort()).toEqual(["fq-t-npm", "fq-t-repo"]);
  });

  it("sorts by created_at DESC", async () => {
    await env.DB.batch([
      insertTheme({
        id: "fq-t-old",
        authorId: "fq-ta",
        name: "Old",
        repositoryUrl: "https://github.com/example/old",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertTheme({
        id: "fq-t-new",
        authorId: "fq-ta",
        name: "New",
        repositoryUrl: "https://github.com/example/new",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    const rows = await listRecentThemesForFeed(env.DB, 50);
    expect(rows.map((r) => r.id)).toEqual(["fq-t-new", "fq-t-old"]);
  });
});

describe("listPluginsByCategoryForFeed", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("fq-ca", "feed-cat-author")]);
    await env.DB.batch([
      insertPlugin({
        id: "fq-c-content-a",
        authorId: "fq-ca",
        name: "Content A",
        category: "content",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-c-content-b",
        authorId: "fq-ca",
        name: "Content B",
        category: "content",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertPlugin({
        id: "fq-c-media",
        authorId: "fq-ca",
        name: "Media Only",
        category: "media",
        createdAt: "2026-01-15T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "cv1",
        pluginId: "fq-c-content-a",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "cv2",
        pluginId: "fq-c-content-b",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertVersion({
        id: "cv3",
        pluginId: "fq-c-media",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-15T00:00:00Z",
        createdAt: "2026-01-15T00:00:00Z",
      }),
    ]);
  });

  it("filters rows to the requested category (WHERE p.category = ?)", async () => {
    const content = await listPluginsByCategoryForFeed(env.DB, "content", 50);
    expect(content.map((r) => r.id).sort()).toEqual([
      "fq-c-content-a",
      "fq-c-content-b",
    ]);
    const media = await listPluginsByCategoryForFeed(env.DB, "media", 50);
    expect(media.map((r) => r.id)).toEqual(["fq-c-media"]);
  });

  it("applies the same active-plugin filter as listRecentPluginsForFeed", async () => {
    await env.DB.batch([
      insertPlugin({
        id: "fq-c-pending",
        authorId: "fq-ca",
        name: "Pending",
        category: "content",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "cvp",
        pluginId: "fq-c-pending",
        version: "1.0.0",
        status: "pending",
        publishedAt: null,
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    const rows = await listPluginsByCategoryForFeed(env.DB, "content", 50);
    expect(rows.map((r) => r.id)).not.toContain("fq-c-pending");
  });

  it("returns empty array for a known-but-empty category", async () => {
    const rows = await listPluginsByCategoryForFeed(env.DB, "analytics", 50);
    expect(rows).toEqual([]);
  });
});
