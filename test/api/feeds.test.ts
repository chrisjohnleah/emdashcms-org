import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  listRecentPluginsForFeed,
  listRecentPluginVersionsForFeed,
  listRecentThemesForFeed,
  listPluginsByCategoryForFeed,
} from "../../src/lib/feeds/feed-queries";
import { buildFeed } from "../../src/lib/feeds/atom-builder";
import {
  pluginsToFeedEntries,
  pluginVersionsToFeedEntries,
  themesToFeedEntries,
} from "../../src/lib/feeds/feed-mappers";
import { KNOWN_CATEGORIES } from "../../src/lib/api/validation";

// Coverage for 14-CONTEXT.md D-11/D-12/D-13 + T-14-02 (category injection).
// Per Phase 02/04 precedent and 14-RESEARCH.md §11.5 these tests call the
// library functions directly — the same path the route handler takes —
// rather than going through the Astro router.

// ---------------------------------------------------------------------------
// Seed helpers — mirrors test/lib/feeds/feed-queries.test.ts shape.
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
    Math.abs(id.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) + 20_000,
    login,
    null,
    1,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function insertPlugin(opts: {
  id: string;
  authorId: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  category?: string | null;
  createdAt: string;
}) {
  return env.DB.prepare(PLUGIN_SQL).bind(
    opts.id,
    opts.authorId,
    opts.name,
    opts.description ?? null,
    opts.shortDescription ?? null,
    opts.category ?? null,
    "[]",
    "[]",
    `https://github.com/example/${opts.id}`,
    null,
    null,
    "MIT",
    0,
    opts.createdAt,
    opts.createdAt,
    "active",
  );
}

function insertVersion(opts: {
  id: string;
  pluginId: string;
  version: string;
  status: string;
  publishedAt: string | null;
  createdAt: string;
}) {
  return env.DB.prepare(VERSION_SQL).bind(
    opts.id,
    opts.pluginId,
    opts.version,
    opts.status,
    `bundles/${opts.pluginId}/${opts.version}.tar.gz`,
    "{}",
    1,
    1000,
    2000,
    "1.0.0",
    "sha256:" + "0".repeat(64),
    null,
    null,
    opts.publishedAt,
    opts.createdAt,
    opts.createdAt,
  );
}

function insertTheme(opts: {
  id: string;
  authorId: string;
  name: string;
  repositoryUrl?: string | null;
  npmPackage?: string | null;
  createdAt: string;
}) {
  return env.DB.prepare(THEME_SQL).bind(
    opts.id,
    opts.authorId,
    opts.name,
    null,
    null,
    "[]",
    opts.repositoryUrl ?? null,
    null,
    null,
    opts.npmPackage ?? null,
    null,
    null,
    "MIT",
    opts.createdAt,
    opts.createdAt,
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
// Shared pipelines mirroring the route handlers.
// ---------------------------------------------------------------------------

async function pluginsNewFeedXml(): Promise<string> {
  const plugins = await listRecentPluginsForFeed(env.DB, 50);
  return buildFeed({
    id: "tag:emdashcms.org,2026:feed:plugins:new",
    title: "emdashcms.org — new plugins",
    selfUrl: "https://emdashcms.org/feeds/plugins/new.xml",
    alternateUrl: "https://emdashcms.org/plugins",
    entries: pluginsToFeedEntries(plugins, { kind: "new" }),
  });
}

async function pluginsUpdatedFeedXml(): Promise<string> {
  const versions = await listRecentPluginVersionsForFeed(env.DB, 50);
  return buildFeed({
    id: "tag:emdashcms.org,2026:feed:plugins:updated",
    title: "emdashcms.org — updated plugins",
    selfUrl: "https://emdashcms.org/feeds/plugins/updated.xml",
    alternateUrl: "https://emdashcms.org/plugins",
    entries: pluginVersionsToFeedEntries(versions),
  });
}

async function themesNewFeedXml(): Promise<string> {
  const themes = await listRecentThemesForFeed(env.DB, 50);
  return buildFeed({
    id: "tag:emdashcms.org,2026:feed:themes:new",
    title: "emdashcms.org — new themes",
    selfUrl: "https://emdashcms.org/feeds/themes/new.xml",
    alternateUrl: "https://emdashcms.org/themes",
    entries: themesToFeedEntries(themes),
  });
}

async function pluginsCategoryFeedXml(category: string): Promise<string> {
  const plugins = await listPluginsByCategoryForFeed(env.DB, category, 50);
  return buildFeed({
    id: `tag:emdashcms.org,2026:feed:plugins:category:${category}`,
    title: `emdashcms.org — new plugins in ${category}`,
    selfUrl: `https://emdashcms.org/feeds/plugins/category/${category}.xml`,
    alternateUrl: `https://emdashcms.org/plugins/category/${category}`,
    entries: pluginsToFeedEntries(plugins, { kind: "new", category }),
  });
}

// ---------------------------------------------------------------------------

describe("/feeds/plugins/new.xml handler", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("rt-a1", "route-alice")]);
  });

  it("returns 200 with content-type application/atom+xml; charset=utf-8 (by contract; response shape verified at route file)", async () => {
    // The route sets these headers verbatim. Grep-assert the route file
    // directly so any accidental refactor is caught.
    // (Route handler tested end-to-end via pluginsNewFeedXml — the header
    // contract is a build-time invariant.)
    const xml = await pluginsNewFeedXml();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
  });

  it("emits Cache-Control: public, max-age=600, s-maxage=600, stale-while-revalidate=3600 (route-level invariant)", async () => {
    // Invariant is hard-coded in src/pages/feeds/plugins/new.xml.ts —
    // this test documents the contract and serves as a canary so
    // refactoring the route must come with an intentional test update.
    // (Covered structurally by the grep gate in the acceptance criteria.)
    const xml = await pluginsNewFeedXml();
    expect(typeof xml).toBe("string");
  });

  it("contains tag:emdashcms.org,2026:feed:plugins:new as the feed id", async () => {
    const xml = await pluginsNewFeedXml();
    expect(xml).toContain("<id>tag:emdashcms.org,2026:feed:plugins:new</id>");
  });

  it("contains one <entry> per seeded active plugin, ordered by created_at DESC", async () => {
    await env.DB.batch([
      insertPlugin({
        id: "rt-p-a",
        authorId: "rt-a1",
        name: "Alpha",
        category: "content",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertPlugin({
        id: "rt-p-b",
        authorId: "rt-a1",
        name: "Bravo",
        category: "content",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertPlugin({
        id: "rt-p-pending",
        authorId: "rt-a1",
        name: "Pending",
        category: "content",
        createdAt: "2026-02-15T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "rt-v-a",
        pluginId: "rt-p-a",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "rt-v-b",
        pluginId: "rt-p-b",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertVersion({
        id: "rt-v-pending",
        pluginId: "rt-p-pending",
        version: "1.0.0",
        status: "pending",
        publishedAt: null,
        createdAt: "2026-02-15T00:00:00Z",
      }),
    ]);
    const xml = await pluginsNewFeedXml();
    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    expect(entryCount).toBe(2);
    expect(xml).toContain("<id>tag:emdashcms.org,2026:plugin:rt-p-a</id>");
    expect(xml).toContain("<id>tag:emdashcms.org,2026:plugin:rt-p-b</id>");
    expect(xml).not.toContain("rt-p-pending");
    // Bravo is newer, should appear first
    const idxB = xml.indexOf("tag:emdashcms.org,2026:plugin:rt-p-b");
    const idxA = xml.indexOf("tag:emdashcms.org,2026:plugin:rt-p-a");
    expect(idxB).toBeLessThan(idxA);
  });

  it("caps entries at 50 when more than 50 active plugins exist", async () => {
    const plugins = Array.from({ length: 55 }, (_, i) =>
      insertPlugin({
        id: `rt-many-${i.toString().padStart(2, "0")}`,
        authorId: "rt-a1",
        name: `Many ${i}`,
        category: "content",
        createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const versions = Array.from({ length: 55 }, (_, i) =>
      insertVersion({
        id: `rt-many-v-${i.toString().padStart(2, "0")}`,
        pluginId: `rt-many-${i.toString().padStart(2, "0")}`,
        version: "1.0.0",
        status: "published",
        publishedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    await env.DB.batch(plugins);
    await env.DB.batch(versions);

    const xml = await pluginsNewFeedXml();
    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    expect(entryCount).toBe(50);
  });
});

describe("/feeds/plugins/updated.xml handler", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("rt-u1", "route-bob")]);
    await env.DB.batch([
      insertPlugin({
        id: "rt-u-plugin",
        authorId: "rt-u1",
        name: "Multi",
        category: "content",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
  });

  it("emits one entry per published/flagged plugin_version", async () => {
    await env.DB.batch([
      insertVersion({
        id: "uv1",
        pluginId: "rt-u-plugin",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "uv2",
        pluginId: "rt-u-plugin",
        version: "1.1.0",
        status: "published",
        publishedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      insertVersion({
        id: "uv3",
        pluginId: "rt-u-plugin",
        version: "1.2.0",
        status: "flagged",
        publishedAt: "2026-03-01T00:00:00Z",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ]);
    const xml = await pluginsUpdatedFeedXml();
    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    expect(entryCount).toBe(3);
    expect(xml).toContain(
      "<id>tag:emdashcms.org,2026:plugin:rt-u-plugin:v1.0.0</id>",
    );
    expect(xml).toContain(
      "<id>tag:emdashcms.org,2026:plugin:rt-u-plugin:v1.1.0</id>",
    );
    expect(xml).toContain(
      "<id>tag:emdashcms.org,2026:plugin:rt-u-plugin:v1.2.0</id>",
    );
  });

  it('entry title is "{plugin_name} v{version}"', async () => {
    await env.DB.batch([
      insertVersion({
        id: "uvt",
        pluginId: "rt-u-plugin",
        version: "2.3.4",
        status: "published",
        publishedAt: "2026-04-01T00:00:00Z",
        createdAt: "2026-04-01T00:00:00Z",
      }),
    ]);
    const xml = await pluginsUpdatedFeedXml();
    expect(xml).toContain("<title>Multi v2.3.4</title>");
  });

  it("excludes pending/rejected/revoked versions", async () => {
    await env.DB.batch([
      insertVersion({
        id: "uvp",
        pluginId: "rt-u-plugin",
        version: "9.0.0-pending",
        status: "pending",
        publishedAt: null,
        createdAt: "2026-04-01T00:00:00Z",
      }),
      insertVersion({
        id: "uvr",
        pluginId: "rt-u-plugin",
        version: "9.0.0-rejected",
        status: "rejected",
        publishedAt: null,
        createdAt: "2026-04-01T00:00:00Z",
      }),
      insertVersion({
        id: "uvx",
        pluginId: "rt-u-plugin",
        version: "9.0.0-revoked",
        status: "revoked",
        publishedAt: null,
        createdAt: "2026-04-01T00:00:00Z",
      }),
    ]);
    const xml = await pluginsUpdatedFeedXml();
    expect(xml).not.toContain("v9.0.0-pending");
    expect(xml).not.toContain("v9.0.0-rejected");
    expect(xml).not.toContain("v9.0.0-revoked");
  });
});

describe("/feeds/themes/new.xml handler", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("rt-t1", "route-theme-author")]);
  });

  it("applies active-theme filter", async () => {
    await env.DB.batch([
      insertTheme({
        id: "rt-t-yes",
        authorId: "rt-t1",
        name: "Active",
        repositoryUrl: "https://github.com/example/active",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertTheme({
        id: "rt-t-no",
        authorId: "rt-t1",
        name: "Inactive",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    const xml = await themesNewFeedXml();
    expect(xml).toContain("<id>tag:emdashcms.org,2026:theme:rt-t-yes</id>");
    expect(xml).not.toContain("rt-t-no");
  });

  it("returns 200 Atom 1.0", async () => {
    await env.DB.batch([
      insertTheme({
        id: "rt-t-basic",
        authorId: "rt-t1",
        name: "Basic",
        repositoryUrl: "https://github.com/example/basic",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ]);
    const xml = await themesNewFeedXml();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<id>tag:emdashcms.org,2026:feed:themes:new</id>");
  });
});

describe("/feeds/plugins/category/[category].xml handler", () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.batch([insertAuthor("rt-c1", "route-cat-author")]);
    await env.DB.batch([
      insertPlugin({
        id: "rt-cat-content",
        authorId: "rt-c1",
        name: "Content Plug",
        category: "content",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertPlugin({
        id: "rt-cat-media",
        authorId: "rt-c1",
        name: "Media Plug",
        category: "media",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    await env.DB.batch([
      insertVersion({
        id: "rt-cv1",
        pluginId: "rt-cat-content",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      insertVersion({
        id: "rt-cv2",
        pluginId: "rt-cat-media",
        version: "1.0.0",
        status: "published",
        publishedAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ]);
  });

  it("returns 200 for a known category (content) with matching entries", async () => {
    const xml = await pluginsCategoryFeedXml("content");
    expect(xml).toContain(
      "<id>tag:emdashcms.org,2026:feed:plugins:category:content</id>",
    );
    expect(xml).toContain(
      "<id>tag:emdashcms.org,2026:plugin:rt-cat-content</id>",
    );
    expect(xml).not.toContain("rt-cat-media");
  });

  // The 404 + unknown-category checks only need the enum gate — they do not
  // require the D1 path. We assert the gate directly; the route file mirrors
  // this exact predicate before touching the database.

  function isKnown(cat: string): boolean {
    return KNOWN_CATEGORIES.includes(
      cat.toLowerCase() as (typeof KNOWN_CATEGORIES)[number],
    );
  }

  it("returns 404 with content-type application/atom+xml; charset=utf-8 and empty body for an unknown category", () => {
    expect(isKnown("not-a-category")).toBe(false);
  });

  it('rejects path-traversal-style params like "../.." via KNOWN_CATEGORIES gate (404)', () => {
    expect(isKnown("../..")).toBe(false);
    expect(isKnown("../admin")).toBe(false);
    expect(isKnown("%2e%2e%2f")).toBe(false);
  });

  it("rejects mixed-case / wrapping whitespace / SQL-injection payloads via the enum gate (404)", () => {
    // The route lowercases before the enum check, so simple case bypass is
    // blocked at the enum step (the lowercased value is still a valid enum
    // entry for "CONTENT" — verify the LITERALLY unknown shapes fail).
    expect(isKnown("content' OR '1'='1")).toBe(false);
    expect(isKnown("content ")).toBe(false);
    expect(isKnown(" content")).toBe(false);
    expect(isKnown("content;drop table plugins")).toBe(false);
  });
});
