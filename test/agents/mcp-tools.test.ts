import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { callMcpTool, McpToolError, MCP_TOOLS } from "../../src/lib/agents/mcp-tools";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB.exec(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('a-mcp', 9001, 'mcp-author', NULL, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
  );

  await env.DB.prepare(
    "INSERT INTO plugins (id, author_id, name, short_description, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "mcp-plugin",
      "a-mcp",
      "MCP Plugin",
      "short",
      "long",
      "analytics",
      "[]",
      "[]",
      null,
      null,
      null,
      "MIT",
      42,
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "v-mcp-1",
      "mcp-plugin",
      "1.0.0",
      "published",
      "bundles/mcp-plugin/1.0.0.tar.gz",
      `{"id":"mcp-plugin","version":"1.0.0","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}`,
      1,
      1024,
      2048,
      null,
      "sha256:" + "b".repeat(8),
      null,
      null,
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO themes (id, author_id, name, short_description, description, category, keywords, repository_url, homepage_url, npm_package, license, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "mcp-theme",
      "a-mcp",
      "MCP Theme",
      "short",
      "long",
      null,
      "[]",
      "https://example.test/repo",
      null,
      null,
      "MIT",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    )
    .run();
});

describe("MCP tools", () => {
  it("MCP_TOOLS exposes exactly the three read-only tools", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "search_plugins",
      "get_plugin",
      "get_theme",
    ]);
  });

  it("search_plugins returns a MarketplaceSearchResult shape", async () => {
    const out = (await callMcpTool(env.DB, "search_plugins", {
      limit: 5,
    })) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(out.items)).toBe(true);
    expect(out.nextCursor).toBeNull();
    expect(out.items.length).toBeGreaterThan(0);
  });

  it("get_plugin returns the seeded plugin and throws for unknown ids", async () => {
    const detail = (await callMcpTool(env.DB, "get_plugin", {
      id: "mcp-plugin",
    })) as { id: string; name: string };
    expect(detail.id).toBe("mcp-plugin");
    expect(detail.name).toBe("MCP Plugin");

    await expect(
      callMcpTool(env.DB, "get_plugin", { id: "missing" }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it("get_theme returns the seeded theme", async () => {
    const detail = (await callMcpTool(env.DB, "get_theme", {
      id: "mcp-theme",
    })) as { id: string; name: string };
    expect(detail.id).toBe("mcp-theme");
    expect(detail.name).toBe("MCP Theme");
  });

  it("rejects unknown tool names with code -32601", async () => {
    await expect(
      callMcpTool(env.DB, "not_a_tool", {}),
    ).rejects.toMatchObject({ code: -32601 });
  });

  it("rejects get_plugin without an id with code -32602", async () => {
    await expect(
      callMcpTool(env.DB, "get_plugin", {}),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
