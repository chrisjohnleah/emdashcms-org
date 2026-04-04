import { env } from "cloudflare:workers";
import {
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "./worker-test-entry";
import type {
  MarketplacePluginSummary,
  MarketplacePluginDetail,
  MarketplaceThemeSummary,
  MarketplaceSearchResult,
  PluginManifest,
  AuditJob,
} from "../src/types/marketplace";

// ---------------------------------------------------------------------------
// FOUN-01 + FOUN-04: D1 Schema — tables, columns, indexes, migration health
// ---------------------------------------------------------------------------

describe("D1 Schema", () => {
  const EXPECTED_TABLES = [
    "authors",
    "plugins",
    "plugin_versions",
    "plugin_audits",
    "installs",
    "themes",
  ];

  it("has all 6 tables", async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all();
    const tables = result.results.map((r: Record<string, unknown>) => r.name as string);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it("authors table has expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(authors)").all();
    const columns = result.results.map((r: Record<string, unknown>) => r.name as string);
    expect(columns).toContain("id");
    expect(columns).toContain("github_id");
    expect(columns).toContain("github_username");
    expect(columns).toContain("avatar_url");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("plugins table has expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(plugins)").all();
    const columns = result.results.map((r: Record<string, unknown>) => r.name as string);
    expect(columns).toContain("id");
    expect(columns).toContain("author_id");
    expect(columns).toContain("name");
    expect(columns).toContain("description");
    expect(columns).toContain("category");
    expect(columns).toContain("capabilities");
    expect(columns).toContain("repository_url");
    expect(columns).toContain("homepage_url");
    expect(columns).toContain("icon_key");
    expect(columns).toContain("installs_count");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("plugin_versions table has expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(plugin_versions)").all();
    const columns = result.results.map((r: Record<string, unknown>) => r.name as string);
    expect(columns).toContain("id");
    expect(columns).toContain("plugin_id");
    expect(columns).toContain("version");
    expect(columns).toContain("status");
    expect(columns).toContain("bundle_key");
    expect(columns).toContain("manifest");
    expect(columns).toContain("file_count");
    expect(columns).toContain("compressed_size");
    expect(columns).toContain("decompressed_size");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("plugin_audits table has expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(plugin_audits)").all();
    const columns = result.results.map((r: Record<string, unknown>) => r.name as string);
    expect(columns).toContain("id");
    expect(columns).toContain("plugin_version_id");
    expect(columns).toContain("status");
    expect(columns).toContain("model");
    expect(columns).toContain("prompt_tokens");
    expect(columns).toContain("completion_tokens");
    expect(columns).toContain("neurons_used");
    expect(columns).toContain("raw_response");
    expect(columns).toContain("issues");
    expect(columns).toContain("created_at");
  });

  it("installs table has expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(installs)").all();
    const columns = result.results.map((r: Record<string, unknown>) => r.name as string);
    expect(columns).toContain("id");
    expect(columns).toContain("plugin_id");
    expect(columns).toContain("created_at");
  });

  it("themes table has expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(themes)").all();
    const columns = result.results.map((r: Record<string, unknown>) => r.name as string);
    expect(columns).toContain("id");
    expect(columns).toContain("author_id");
    expect(columns).toContain("name");
    expect(columns).toContain("description");
    expect(columns).toContain("keywords");
    expect(columns).toContain("repository_url");
    expect(columns).toContain("demo_url");
    expect(columns).toContain("thumbnail_key");
    expect(columns).toContain("npm_package");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("has all expected indexes", async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
    ).all();
    const indexes = result.results.map((r: Record<string, unknown>) => r.name as string);
    const EXPECTED_INDEXES = [
      "idx_plugins_author",
      "idx_plugins_category",
      "idx_plugins_installs",
      "idx_versions_plugin",
      "idx_versions_status",
      "idx_versions_plugin_status",
      "idx_audits_version",
      "idx_installs_plugin",
      "idx_installs_date",
      "idx_themes_author",
    ];
    for (const idx of EXPECTED_INDEXES) {
      expect(indexes).toContain(idx);
    }
  });

  it("migrations apply cleanly - can insert and read authors", async () => {
    await env.DB.prepare(
      "INSERT INTO authors (id, github_id, github_username, avatar_url) VALUES (?, ?, ?, ?)",
    )
      .bind("author-1", 12345, "testuser", "https://github.com/testuser.png")
      .run();

    const author = await env.DB.prepare(
      "SELECT * FROM authors WHERE id = ?",
    )
      .bind("author-1")
      .first();

    expect(author).not.toBeNull();
    expect(author!.github_username).toBe("testuser");
    expect(author!.github_id).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// FOUN-02: Custom Worker — fetch handler + queue consumer
// ---------------------------------------------------------------------------

describe("Custom Worker", () => {
  it("fetch handler returns a Response", async () => {
    const request = new Request("http://localhost:8787/");
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(600);
  });

  it("queue handler acknowledges messages", async () => {
    const batch = createMessageBatch("emdashcms-audit", [
      {
        id: "msg-1",
        timestamp: new Date(),
        attempts: 1,
        body: {
          pluginId: "test-plugin",
          version: "1.0.0",
          authorId: "author-1",
          bundleKey: "bundles/test/1.0.0.tar.gz",
        },
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toContain("msg-1");
    expect(result.retryMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FOUN-03: MarketplaceClient Types — structural validation with fixtures
// ---------------------------------------------------------------------------

describe("MarketplaceClient Types", () => {
  it("MarketplacePluginSummary has all required fields", () => {
    const fixture: MarketplacePluginSummary = {
      id: "my-plugin",
      name: "My Plugin",
      description: "A test plugin",
      author: { name: "testuser", verified: false, avatarUrl: null },
      capabilities: ["content"],
      keywords: ["test"],
      installCount: 0,
      hasIcon: false,
      iconUrl: null,
      latestVersion: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(fixture.id).toBe("my-plugin");
    expect(fixture.author.name).toBe("testuser");
    expect(Array.isArray(fixture.capabilities)).toBe(true);
    expect(typeof fixture.installCount).toBe("number");
  });

  it("MarketplaceSearchResult wraps items with cursor", () => {
    const fixture: MarketplaceSearchResult<MarketplacePluginSummary> = {
      items: [],
      nextCursor: null,
    };
    expect(Array.isArray(fixture.items)).toBe(true);
    expect(fixture.nextCursor).toBeNull();
  });

  it("PluginManifest has required fields", () => {
    const fixture: PluginManifest = {
      id: "my-plugin",
      version: "1.0.0",
      capabilities: ["content"],
      allowedHosts: [],
      storage: null,
      hooks: [],
      routes: [],
      admin: null,
    };
    expect(fixture.id).toBe("my-plugin");
    expect(Array.isArray(fixture.capabilities)).toBe(true);
  });

  it("AuditJob has required fields", () => {
    const fixture: AuditJob = {
      pluginId: "my-plugin",
      version: "1.0.0",
      authorId: "author-1",
      bundleKey: "bundles/my-plugin/1.0.0.tar.gz",
    };
    expect(fixture.pluginId).toBe("my-plugin");
    expect(fixture.bundleKey).toContain("bundles/");
  });
});

// ---------------------------------------------------------------------------
// FOUN-05: API Contract Shape — D1 data maps to MarketplacePluginSummary
// ---------------------------------------------------------------------------

describe("API Contract Shape", () => {
  it("D1 data maps to MarketplacePluginSummary shape", async () => {
    // Insert seed data
    await env.DB.prepare(
      "INSERT INTO authors (id, github_id, github_username, avatar_url) VALUES (?, ?, ?, ?)",
    )
      .bind(
        "a1",
        99999,
        "seeduser",
        "https://avatars.githubusercontent.com/u/99999",
      )
      .run();

    await env.DB.prepare(
      "INSERT INTO plugins (id, author_id, name, description, category, capabilities, repository_url, homepage_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "p1",
        "a1",
        "Seed Plugin",
        "A seed plugin",
        "content",
        '["content","api"]',
        "https://github.com/test/seed-plugin",
        null,
      )
      .run();

    // Query back and map to contract type
    const plugin = await env.DB.prepare(
      "SELECT * FROM plugins WHERE id = ?",
    )
      .bind("p1")
      .first();
    const author = await env.DB.prepare(
      "SELECT * FROM authors WHERE id = ?",
    )
      .bind("a1")
      .first();

    expect(plugin).not.toBeNull();
    expect(author).not.toBeNull();

    // Build response shape
    const summary: MarketplacePluginSummary = {
      id: plugin!.id as string,
      name: plugin!.name as string,
      description: plugin!.description as string | null,
      author: {
        name: author!.github_username as string,
        verified: false,
        avatarUrl: author!.avatar_url as string | null,
      },
      capabilities: JSON.parse(plugin!.capabilities as string),
      keywords: [],
      installCount: plugin!.installs_count as number,
      hasIcon: plugin!.icon_key !== null,
      iconUrl: null,
      latestVersion: null,
      createdAt: plugin!.created_at as string,
      updatedAt: plugin!.updated_at as string,
    };

    // Verify shape
    expect(typeof summary.id).toBe("string");
    expect(typeof summary.name).toBe("string");
    expect(typeof summary.author.name).toBe("string");
    expect(typeof summary.author.verified).toBe("boolean");
    expect(Array.isArray(summary.capabilities)).toBe(true);
    expect(summary.capabilities).toEqual(["content", "api"]);
    expect(typeof summary.installCount).toBe("number");
    expect(summary.installCount).toBe(0);
    expect(typeof summary.createdAt).toBe("string");
  });
});
