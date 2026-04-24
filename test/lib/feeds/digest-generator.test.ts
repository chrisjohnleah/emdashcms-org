import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  runWeeklyDigest,
  snapshotWeek,
  type WeeklyDigestManifest,
} from "../../../src/lib/feeds/digest-generator";
import { getIsoWeek } from "../../../src/lib/feeds/iso-week";

// Coverage for 14-CONTEXT.md D-19..D-28 (snapshot + idempotency) and FEED-05.
//
// Seed helpers mirror test/lib/feeds/feed-queries.test.ts (post-migration
// 0013/0023 column lists). The tests inject a fixed `now` into runWeeklyDigest
// so we can pin expected ISO week slugs without clock dependency.

// ---------------------------------------------------------------------------
// Seed helpers
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
  // Deterministic github_id from the string so we don't collide across seeds
  const ghId =
    Math.abs(id.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) + 100_000;
  return env.DB.prepare(AUTHOR_SQL).bind(
    id,
    ghId,
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
    env.DB.prepare("DELETE FROM weekly_digests"),
    env.DB.prepare("DELETE FROM installs"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);
}

beforeEach(async () => {
  await wipe();
});

// ---------------------------------------------------------------------------
// Constants pinned to D-24 worked examples
// ---------------------------------------------------------------------------

// Cron fires Sunday 00:05 UTC. The first Sunday after our chosen reference
// week (W15: Mon 2026-04-06 – Sun 2026-04-12) is 2026-04-19. Subtracting 7
// days lands at 2026-04-12 which is inside W15 — the week that just ended.
const NOW_SUNDAY = new Date("2026-04-19T00:05:00Z");
const EXPECTED_SLUG = "2026-W15";
const EXPECTED_WINDOW_START = "2026-04-06T00:00:00.000Z";
const EXPECTED_WINDOW_END = "2026-04-12T23:59:59.999Z";

// A timestamp that lands inside the W15 window
const IN_WINDOW = "2026-04-08T12:00:00.000Z";
// A timestamp just before the window start
const BEFORE_WINDOW = "2026-04-05T23:00:00.000Z";
// A timestamp just after the window end
const AFTER_WINDOW = "2026-04-13T01:00:00.000Z";

// ---------------------------------------------------------------------------

describe("runWeeklyDigest", () => {
  it("writes exactly one row to weekly_digests per run", async () => {
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT iso_week, manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ iso_week: string; manifest_json: string }>();
    expect(row).not.toBeNull();
    expect(row?.iso_week).toBe(EXPECTED_SLUG);
  });

  it("is idempotent: running twice still leaves one row (INSERT OR REPLACE)", async () => {
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("manifest_json is valid JSON and parses as WeeklyDigestManifest", async () => {
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    expect(parsed.version).toBe(1);
    expect(parsed.isoWeek).toBe(EXPECTED_SLUG);
    expect(Array.isArray(parsed.newPlugins)).toBe(true);
    expect(Array.isArray(parsed.updatedPlugins)).toBe(true);
    expect(Array.isArray(parsed.newThemes)).toBe(true);
  });

  it("captures windowStartUtc / windowEndUtc from getIsoWeek(now - 7 days) per D-24", async () => {
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    expect(parsed.windowStartUtc).toBe(EXPECTED_WINDOW_START);
    expect(parsed.windowEndUtc).toBe(EXPECTED_WINDOW_END);
  });

  it("newPlugins captures plugins created within the window only", async () => {
    await insertAuthor("a1", "alice").run();
    await env.DB.batch([
      insertPlugin({
        id: "p-in",
        authorId: "a1",
        name: "In-window Plugin",
        shortDescription: "inside",
        category: "content",
        createdAt: IN_WINDOW,
      }),
      insertPlugin({
        id: "p-before",
        authorId: "a1",
        name: "Before-window Plugin",
        createdAt: BEFORE_WINDOW,
      }),
      insertPlugin({
        id: "p-after",
        authorId: "a1",
        name: "After-window Plugin",
        createdAt: AFTER_WINDOW,
      }),
      insertVersion({
        id: "v-in",
        pluginId: "p-in",
        version: "1.0.0",
        status: "published",
        publishedAt: IN_WINDOW,
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-before",
        pluginId: "p-before",
        version: "1.0.0",
        status: "published",
        publishedAt: BEFORE_WINDOW,
        createdAt: BEFORE_WINDOW,
      }),
      insertVersion({
        id: "v-after",
        pluginId: "p-after",
        version: "1.0.0",
        status: "published",
        publishedAt: AFTER_WINDOW,
        createdAt: AFTER_WINDOW,
      }),
    ]);

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;

    const ids = parsed.newPlugins.map((p) => p.id).sort();
    expect(ids).toEqual(["p-in"]);
    expect(parsed.newPlugins[0].shortDescription).toBe("inside");
    expect(parsed.newPlugins[0].category).toBe("content");
    expect(parsed.newPlugins[0].authorLogin).toBe("alice");
  });

  it("newPlugins excludes plugins with no published/flagged version (pending-only)", async () => {
    await insertAuthor("a1", "alice").run();
    await env.DB.batch([
      insertPlugin({
        id: "p-pending",
        authorId: "a1",
        name: "Pending Only",
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-pending",
        pluginId: "p-pending",
        version: "1.0.0",
        status: "pending",
        publishedAt: null,
        createdAt: IN_WINDOW,
      }),
    ]);

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    expect(parsed.newPlugins.map((p) => p.id)).not.toContain("p-pending");
  });

  it("updatedPlugins captures one entry per published/flagged version in window", async () => {
    await insertAuthor("a1", "alice").run();
    await insertPlugin({
      id: "p-multi",
      authorId: "a1",
      name: "Multi-version",
      createdAt: BEFORE_WINDOW, // plugin itself older than window
    }).run();
    await env.DB.batch([
      insertVersion({
        id: "v-multi-1",
        pluginId: "p-multi",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-04-07T08:00:00.000Z",
        createdAt: "2026-04-07T08:00:00.000Z",
      }),
      insertVersion({
        id: "v-multi-2",
        pluginId: "p-multi",
        version: "1.1.0",
        status: "published",
        publishedAt: "2026-04-09T08:00:00.000Z",
        createdAt: "2026-04-09T08:00:00.000Z",
      }),
      insertVersion({
        id: "v-multi-3",
        pluginId: "p-multi",
        version: "1.2.0",
        status: "flagged",
        publishedAt: "2026-04-11T08:00:00.000Z",
        createdAt: "2026-04-11T08:00:00.000Z",
      }),
    ]);

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;

    expect(parsed.updatedPlugins).toHaveLength(3);
    const versions = parsed.updatedPlugins.map((u) => u.version).sort();
    expect(versions).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    // All three entries should reference the same plugin_id / name
    for (const u of parsed.updatedPlugins) {
      expect(u.pluginId).toBe("p-multi");
      expect(u.name).toBe("Multi-version");
      expect(u.authorLogin).toBe("alice");
    }
  });

  it("updatedPlugins excludes pending/rejected/revoked versions", async () => {
    await insertAuthor("a1", "alice").run();
    await insertPlugin({
      id: "p-mixed",
      authorId: "a1",
      name: "Mixed Statuses",
      createdAt: BEFORE_WINDOW,
    }).run();
    await env.DB.batch([
      insertVersion({
        id: "v-pub",
        pluginId: "p-mixed",
        version: "1.0.0",
        status: "published",
        publishedAt: IN_WINDOW,
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-pen",
        pluginId: "p-mixed",
        version: "1.1.0",
        status: "pending",
        publishedAt: null,
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-rej",
        pluginId: "p-mixed",
        version: "1.2.0",
        status: "rejected",
        publishedAt: null,
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-rev",
        pluginId: "p-mixed",
        version: "1.3.0",
        status: "revoked",
        publishedAt: IN_WINDOW,
        createdAt: IN_WINDOW,
      }),
    ]);

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    const versions = parsed.updatedPlugins.map((u) => u.version);
    expect(versions).toEqual(["1.0.0"]);
  });

  it("excludes unlisted plugins from newPlugins and updatedPlugins (Phase 17 DEPR-06 regression)", async () => {
    await insertAuthor("a1", "alice").run();
    await env.DB.batch([
      insertPlugin({
        id: "p-unlisted",
        authorId: "a1",
        name: "Unlisted Plugin",
        shortDescription: "hidden",
        category: "content",
        createdAt: IN_WINDOW,
      }),
      insertPlugin({
        id: "p-listed",
        authorId: "a1",
        name: "Listed Plugin",
        shortDescription: "visible",
        category: "content",
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-unlisted",
        pluginId: "p-unlisted",
        version: "1.0.0",
        status: "published",
        publishedAt: IN_WINDOW,
        createdAt: IN_WINDOW,
      }),
      insertVersion({
        id: "v-listed",
        pluginId: "p-listed",
        version: "1.0.0",
        status: "published",
        publishedAt: IN_WINDOW,
        createdAt: IN_WINDOW,
      }),
    ]);
    // Flip the unlisted_at flag AFTER insert so the column (nullable, default
    // NULL) is set without changing the shared PLUGIN_SQL seed shape.
    await env.DB.prepare("UPDATE plugins SET unlisted_at = ? WHERE id = ?")
      .bind(IN_WINDOW, "p-unlisted")
      .run();

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;

    const newIds = parsed.newPlugins.map((p) => p.id);
    expect(newIds).toContain("p-listed");
    expect(newIds).not.toContain("p-unlisted");

    const updatedPluginIds = parsed.updatedPlugins.map((u) => u.pluginId);
    expect(updatedPluginIds).toContain("p-listed");
    expect(updatedPluginIds).not.toContain("p-unlisted");
  });

  it("excludes updatedPlugins entries when the parent plugin has status=revoked (Rule 3 hardening)", async () => {
    await insertAuthor("a1", "alice").run();
    await insertPlugin({
      id: "p-revoked",
      authorId: "a1",
      name: "Revoked Plugin",
      createdAt: BEFORE_WINDOW,
      status: "revoked",
    }).run();
    await insertVersion({
      id: "v-revoked-in",
      pluginId: "p-revoked",
      version: "1.1.0",
      status: "published",
      publishedAt: IN_WINDOW,
      createdAt: IN_WINDOW,
    }).run();

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;

    const updatedPluginIds = parsed.updatedPlugins.map((u) => u.pluginId);
    expect(updatedPluginIds).not.toContain("p-revoked");
  });

  it("newThemes captures themes created within the window with the active-theme filter", async () => {
    await insertAuthor("a1", "alice").run();
    await env.DB.batch([
      insertTheme({
        id: "t-active",
        authorId: "a1",
        name: "Active Theme",
        shortDescription: "hi",
        repositoryUrl: "https://github.com/example/t-active",
        createdAt: IN_WINDOW,
      }),
      insertTheme({
        id: "t-npm",
        authorId: "a1",
        name: "NPM Theme",
        npmPackage: "@ex/theme",
        createdAt: IN_WINDOW,
      }),
      insertTheme({
        id: "t-inert",
        authorId: "a1",
        name: "Inert Theme",
        createdAt: IN_WINDOW,
        // Neither repositoryUrl nor npmPackage -> must be filtered out
      }),
      insertTheme({
        id: "t-before",
        authorId: "a1",
        name: "Before Theme",
        repositoryUrl: "https://github.com/example/t-before",
        createdAt: BEFORE_WINDOW,
      }),
    ]);

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    const ids = parsed.newThemes.map((t) => t.id).sort();
    expect(ids).toEqual(["t-active", "t-npm"]);
  });

  it("counts object matches the length of each array", async () => {
    await insertAuthor("a1", "alice").run();
    await insertPlugin({
      id: "p-cnt",
      authorId: "a1",
      name: "Count Plugin",
      createdAt: IN_WINDOW,
    }).run();
    await insertVersion({
      id: "v-cnt",
      pluginId: "p-cnt",
      version: "1.0.0",
      status: "published",
      publishedAt: IN_WINDOW,
      createdAt: IN_WINDOW,
    }).run();

    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    expect(parsed.counts.newPlugins).toBe(parsed.newPlugins.length);
    expect(parsed.counts.updatedPlugins).toBe(parsed.updatedPlugins.length);
    expect(parsed.counts.newThemes).toBe(parsed.newThemes.length);
  });

  it("empty week writes a row with three empty arrays and zero counts", async () => {
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT manifest_json FROM weekly_digests WHERE iso_week = ?",
    )
      .bind(EXPECTED_SLUG)
      .first<{ manifest_json: string }>();
    const parsed = JSON.parse(row!.manifest_json) as WeeklyDigestManifest;
    expect(parsed.newPlugins).toEqual([]);
    expect(parsed.updatedPlugins).toEqual([]);
    expect(parsed.newThemes).toEqual([]);
    expect(parsed.counts).toEqual({
      newPlugins: 0,
      updatedPlugins: 0,
      newThemes: 0,
    });
  });

  it("runWeeklyDigest(env, new Date('2026-04-19T00:05:00Z')) writes iso_week=2026-W15", async () => {
    await runWeeklyDigest({ DB: env.DB }, NOW_SUNDAY);
    const row = await env.DB.prepare(
      "SELECT iso_week FROM weekly_digests",
    ).first<{ iso_week: string }>();
    expect(row?.iso_week).toBe("2026-W15");
  });

  it("runWeeklyDigest(env, new Date('2026-01-04T00:05:00Z')) writes iso_week=2025-W52 (year-boundary robustness)", async () => {
    await runWeeklyDigest({ DB: env.DB }, new Date("2026-01-04T00:05:00Z"));
    const row = await env.DB.prepare(
      "SELECT iso_week FROM weekly_digests",
    ).first<{ iso_week: string }>();
    expect(row?.iso_week).toBe("2025-W52");
  });

  it("defaults `now` to new Date() when omitted (dependency-injected signature)", async () => {
    // Just smoke-test that the call shape works; we don't pin the resulting slug
    // because it's clock-dependent. It should create exactly one row.
    await runWeeklyDigest({ DB: env.DB });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM weekly_digests",
    ).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});

describe("snapshotWeek", () => {
  it("returns WeeklyDigestManifest for the given IsoWeek", async () => {
    const week = getIsoWeek(new Date("2026-04-08T12:00:00Z")); // 2026-W15
    const manifest = await snapshotWeek(env.DB, week);
    expect(manifest.version).toBe(1);
    expect(manifest.isoWeek).toBe("2026-W15");
    expect(manifest.windowStartUtc).toBe(EXPECTED_WINDOW_START);
    expect(manifest.windowEndUtc).toBe(EXPECTED_WINDOW_END);
    expect(manifest.newPlugins).toEqual([]);
    expect(manifest.updatedPlugins).toEqual([]);
    expect(manifest.newThemes).toEqual([]);
    expect(manifest.counts).toEqual({
      newPlugins: 0,
      updatedPlugins: 0,
      newThemes: 0,
    });
  });
});
