import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  getPublishedVersionBundle,
  trackInstall,
  pluginExists,
  incrementPluginDownloads,
  incrementThemeDownloads,
  themeExists,
} from "../../src/lib/downloads/queries";
import { checkRateLimit } from "../../src/lib/downloads/rate-limit";
import { searchPlugins, getPluginDetail } from "../../src/lib/db/queries";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function seedTestAuthor(
  db: D1Database,
  id: string,
  githubId: number,
  username: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      githubId,
      username,
      `https://avatars.githubusercontent.com/u/${githubId}`,
      1,
      "2026-04-04T08:00:00Z",
      "2026-04-04T08:00:00Z",
    )
    .run();
}

async function seedTestPlugin(
  db: D1Database,
  pluginId: string,
  authorId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '2026-04-04T08:00:00Z', '2026-04-04T08:00:00Z')`,
    )
    .bind(
      pluginId,
      authorId,
      `Test Plugin ${pluginId}`,
      `Description for ${pluginId}`,
      "content",
      '["content:read"]',
      '["test"]',
    )
    .run();
}

async function seedTestVersion(
  db: D1Database,
  pluginId: string,
  version: string,
  status: string,
  bundleKey: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, checksum, screenshots, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', 2, 1024, 4096, 'sha256:testchecksum', '[]', 0, '2026-04-04T09:00:00Z', '2026-04-04T09:00:00Z')`,
    )
    .bind(id, pluginId, version, status, bundleKey)
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const TEST_BUNDLE = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]).buffer;
const BUNDLE_KEY = "plugins/dl-test-plugin/1.0.0/bundle.tgz";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits"),
    env.DB.prepare("DELETE FROM installs"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await seedTestAuthor(env.DB, "dl-author-1", 8001, "dl-test-publisher");
  await seedTestPlugin(env.DB, "dl-test-plugin", "dl-author-1");

  // Create versions in various statuses
  await seedTestVersion(
    env.DB,
    "dl-test-plugin",
    "1.0.0",
    "published",
    BUNDLE_KEY,
  );
  await seedTestVersion(
    env.DB,
    "dl-test-plugin",
    "1.1.0",
    "flagged",
    "plugins/dl-test-plugin/1.1.0/bundle.tgz",
  );
  await seedTestVersion(
    env.DB,
    "dl-test-plugin",
    "2.0.0-beta",
    "pending",
    "plugins/dl-test-plugin/2.0.0-beta/bundle.tgz",
  );
  await seedTestVersion(
    env.DB,
    "dl-test-plugin",
    "0.9.0",
    "rejected",
    "plugins/dl-test-plugin/0.9.0/bundle.tgz",
  );

  // Store a test tarball in R2 for download tests
  await env.ARTIFACTS.put(BUNDLE_KEY, TEST_BUNDLE, {
    httpMetadata: { contentType: "application/gzip" },
  });
});

// ---------------------------------------------------------------------------
// DOWN-01: Bundle download queries
// ---------------------------------------------------------------------------

describe("DOWN-01: Bundle download queries", () => {
  it("returns bundle info for a published version", async () => {
    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-test-plugin",
      "1.0.0",
    );
    expect(result).not.toBeNull();
    expect(result!.bundleKey).toBe(BUNDLE_KEY);
    expect(result!.compressedSize).toBe(1024);
    expect(result!.checksum).toBe("sha256:testchecksum");
  });

  it("returns bundle info for a flagged version (D-02)", async () => {
    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-test-plugin",
      "1.1.0",
    );
    expect(result).not.toBeNull();
    expect(result!.bundleKey).toBe(
      "plugins/dl-test-plugin/1.1.0/bundle.tgz",
    );
  });

  it("returns null for a pending version", async () => {
    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-test-plugin",
      "2.0.0-beta",
    );
    expect(result).toBeNull();
  });

  it("returns null for a rejected version", async () => {
    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-test-plugin",
      "0.9.0",
    );
    expect(result).toBeNull();
  });

  it("returns null for a non-existent version", async () => {
    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-test-plugin",
      "99.99.99",
    );
    expect(result).toBeNull();
  });

  it("returns null when the parent plugin is revoked, even for a published version", async () => {
    // Seed a second plugin that is revoked with a published version.
    // We keep the default plugin active so other tests continue to work.
    await seedTestPlugin(env.DB, "dl-revoked-plugin", "dl-author-1");
    await env.DB.prepare(
      "UPDATE plugins SET status = 'revoked' WHERE id = ?",
    )
      .bind("dl-revoked-plugin")
      .run();
    await seedTestVersion(
      env.DB,
      "dl-revoked-plugin",
      "1.0.0",
      "published",
      "plugins/dl-revoked-plugin/1.0.0/bundle.tgz",
    );

    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-revoked-plugin",
      "1.0.0",
    );
    expect(result).toBeNull();
  });

  it("returns bundle info again after a revoked plugin is restored", async () => {
    await env.DB.prepare(
      "UPDATE plugins SET status = 'active' WHERE id = ?",
    )
      .bind("dl-revoked-plugin")
      .run();

    const result = await getPublishedVersionBundle(
      env.DB,
      "dl-revoked-plugin",
      "1.0.0",
    );
    expect(result).not.toBeNull();
    expect(result!.bundleKey).toBe(
      "plugins/dl-revoked-plugin/1.0.0/bundle.tgz",
    );
  });

  it("returns null for a per-version revoked version (leaves other versions intact)", async () => {
    // Seed a plugin with two published versions, revoke only one.
    await seedTestPlugin(env.DB, "dl-partial-revoke", "dl-author-1");
    await seedTestVersion(
      env.DB,
      "dl-partial-revoke",
      "1.0.0",
      "published",
      "plugins/dl-partial-revoke/1.0.0/bundle.tgz",
    );
    await seedTestVersion(
      env.DB,
      "dl-partial-revoke",
      "1.1.0",
      "revoked",
      "plugins/dl-partial-revoke/1.1.0/bundle.tgz",
    );

    const bad = await getPublishedVersionBundle(
      env.DB,
      "dl-partial-revoke",
      "1.1.0",
    );
    expect(bad).toBeNull();

    const good = await getPublishedVersionBundle(
      env.DB,
      "dl-partial-revoke",
      "1.0.0",
    );
    expect(good).not.toBeNull();
    expect(good!.bundleKey).toBe("plugins/dl-partial-revoke/1.0.0/bundle.tgz");
  });
});

// ---------------------------------------------------------------------------
// DOWN-02: Install tracking
// ---------------------------------------------------------------------------

describe("DOWN-02: Install tracking", () => {
  it("inserts a new install record and increments installs_count", async () => {
    const countBefore = await env.DB.prepare(
      "SELECT installs_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ installs_count: number }>();

    const result = await trackInstall(
      env.DB,
      "dl-test-plugin",
      "site-hash-aaa",
      "1.0.0",
    );
    expect(result.inserted).toBe(true);

    const countAfter = await env.DB.prepare(
      "SELECT installs_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ installs_count: number }>();

    expect(countAfter!.installs_count).toBe(
      countBefore!.installs_count + 1,
    );
  });

  it("deduplicates same siteHash+version and does NOT increment count", async () => {
    const countBefore = await env.DB.prepare(
      "SELECT installs_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ installs_count: number }>();

    const result = await trackInstall(
      env.DB,
      "dl-test-plugin",
      "site-hash-aaa",
      "1.0.0",
    );
    expect(result.inserted).toBe(false);

    const countAfter = await env.DB.prepare(
      "SELECT installs_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ installs_count: number }>();

    expect(countAfter!.installs_count).toBe(countBefore!.installs_count);
  });

  it("inserts when different siteHash for same plugin+version", async () => {
    const countBefore = await env.DB.prepare(
      "SELECT installs_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ installs_count: number }>();

    const result = await trackInstall(
      env.DB,
      "dl-test-plugin",
      "site-hash-bbb",
      "1.0.0",
    );
    expect(result.inserted).toBe(true);

    const countAfter = await env.DB.prepare(
      "SELECT installs_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ installs_count: number }>();

    expect(countAfter!.installs_count).toBe(
      countBefore!.installs_count + 1,
    );
  });

  it("pluginExists returns true for existing plugin", async () => {
    const exists = await pluginExists(env.DB, "dl-test-plugin");
    expect(exists).toBe(true);
  });

  it("pluginExists returns false for non-existent plugin", async () => {
    const exists = await pluginExists(env.DB, "no-such-plugin-xyz");
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DOWN-03: Install counts in API responses
// ---------------------------------------------------------------------------

describe("DOWN-03: Install counts in API responses", () => {
  it("searchPlugins returns updated installCount", async () => {
    const result = await searchPlugins(env.DB, {
      query: "dl-test-plugin",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    const plugin = result.items.find((p) => p.id === "dl-test-plugin");
    expect(plugin).toBeDefined();
    // We inserted 2 unique installs in the DOWN-02 tests above
    expect(plugin!.installCount).toBe(2);
  });

  it("getPluginDetail returns updated installCount", async () => {
    const detail = await getPluginDetail(env.DB, "dl-test-plugin");
    expect(detail).not.toBeNull();
    expect(detail!.installCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DOWN-04: Raw download counters (browser ZIP + CLI bundle GETs)
// ---------------------------------------------------------------------------

describe("DOWN-04: Raw download counters", () => {
  it("incrementPluginDownloads bumps the plugin downloads_count", async () => {
    const before = await env.DB.prepare(
      "SELECT downloads_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ downloads_count: number }>();

    await incrementPluginDownloads(env.DB, "dl-test-plugin");
    await incrementPluginDownloads(env.DB, "dl-test-plugin");
    await incrementPluginDownloads(env.DB, "dl-test-plugin");

    const after = await env.DB.prepare(
      "SELECT downloads_count FROM plugins WHERE id = ?",
    )
      .bind("dl-test-plugin")
      .first<{ downloads_count: number }>();

    expect(after!.downloads_count).toBe((before?.downloads_count ?? 0) + 3);
  });

  it("searchPlugins exposes downloadCount in summary", async () => {
    const result = await searchPlugins(env.DB, {
      query: "dl-test-plugin",
      category: null,
      capability: null,
      sort: "downloads",
      cursor: null,
      limit: 20,
    });

    const plugin = result.items.find((p) => p.id === "dl-test-plugin");
    expect(plugin).toBeDefined();
    expect(plugin!.downloadCount).toBeGreaterThanOrEqual(3);
  });

  it("getPluginDetail exposes downloadCount", async () => {
    const detail = await getPluginDetail(env.DB, "dl-test-plugin");
    expect(detail).not.toBeNull();
    expect(detail!.downloadCount).toBeGreaterThanOrEqual(3);
  });

  it("incrementThemeDownloads bumps the theme downloads_count", async () => {
    // Seed a theme inline — themes table is otherwise untouched in this file
    await env.DB.prepare(
      `INSERT INTO themes (id, author_id, name, description, repository_url, demo_url, npm_package, keywords, created_at, updated_at)
       VALUES ('dl-test-theme', 'dl-author-1', 'Test Theme', 'A test theme', 'https://example.com/repo', 'https://example.com/demo', '@test/theme', '[]', '2026-04-04T08:00:00Z', '2026-04-04T08:00:00Z')`,
    ).run();

    const before = await env.DB.prepare(
      "SELECT downloads_count FROM themes WHERE id = ?",
    )
      .bind("dl-test-theme")
      .first<{ downloads_count: number }>();
    expect(before!.downloads_count).toBe(0);

    await incrementThemeDownloads(env.DB, "dl-test-theme");
    await incrementThemeDownloads(env.DB, "dl-test-theme");

    const after = await env.DB.prepare(
      "SELECT downloads_count FROM themes WHERE id = ?",
    )
      .bind("dl-test-theme")
      .first<{ downloads_count: number }>();
    expect(after!.downloads_count).toBe(2);
  });

  it("themeExists returns true for an existing theme", async () => {
    const exists = await themeExists(env.DB, "dl-test-theme");
    expect(exists).toBe(true);
  });

  it("themeExists returns false for an unknown theme", async () => {
    const exists = await themeExists(env.DB, "no-such-theme-xyz");
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// COST-04: Rate limiting
// ---------------------------------------------------------------------------

describe("COST-04: Rate limiting", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM rate_limits").run();
  });

  it("allows requests under 60/min threshold", async () => {
    const result = await checkRateLimit(env.DB, "127.0.0.1", 60);
    expect(result.allowed).toBe(true);
  });

  it("blocks requests after 60 in the same minute", async () => {
    // Seed the rate_limits table with 60 requests for the current minute
    const minute = new Date().toISOString().slice(0, 16);
    const key = `127.0.0.1:${minute}`;
    await env.DB.prepare(
      "INSERT INTO rate_limits (minute, request_count) VALUES (?, 60)",
    )
      .bind(key)
      .run();

    // The 61st request should be blocked
    const result = await checkRateLimit(env.DB, "127.0.0.1", 60);
    expect(result.allowed).toBe(false);
  });
});
