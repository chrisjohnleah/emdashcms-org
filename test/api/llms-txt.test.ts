/**
 * Integration tests for /llms.txt (AIDX-01).
 *
 * The vitest-pool-workers runtime resolves both `cloudflare:workers`
 * and `cloudflare:test` to the same test env, so we can import the
 * route's `GET` handler directly and invoke it with a synthesised
 * Request — no HTTP fetch, no Astro render pipeline needed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { GET } from "../../src/pages/llms.txt";

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB.exec(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('author-llms', 7001, 'llms-author', NULL, 1, '2026-01-10T08:00:00Z', '2026-03-20T12:00:00Z');",
  );
});

async function seedPlugin(
  id: string,
  name: string,
  installs: number,
  versionStatus: "published" | "flagged" | "rejected",
) {
  await env.DB.prepare(
    "INSERT INTO plugins (id, author_id, name, short_description, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "author-llms",
      name,
      `one-line description of ${name}`,
      null,
      "content",
      "[]",
      "[]",
      null,
      null,
      null,
      "MIT",
      installs,
      "2026-01-15T10:00:00Z",
      "2026-03-20T12:00:00Z",
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `pv-${id}-1`,
      id,
      "1.0.0",
      versionStatus,
      `bundles/${id}/1.0.0.tar.gz`,
      `{"id":"${id}","version":"1.0.0","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}`,
      3,
      10000,
      25000,
      null,
      "sha256:" + "a".repeat(8),
      null,
      null,
      versionStatus === "published" ? "2026-01-20T12:00:00Z" : null,
      "2026-01-20T10:00:00Z",
      "2026-01-20T12:00:00Z",
    )
    .run();
}

async function clearPlugins() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
  ]);
}

function makeRequest(): Request {
  return new Request("https://emdashcms.org/llms.txt", { method: "GET" });
}

async function invokeLlmsTxt(): Promise<Response> {
  // Astro's APIContext has many fields; the route only reads `env` via
  // `cloudflare:workers`, so an empty shim is sufficient for tests.
  return (GET as unknown as (ctx: { request: Request }) => Promise<Response>)({
    request: makeRequest(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/llms.txt endpoint", () => {
  it("returns 200 with the correct Content-Type and Cache-Control headers", async () => {
    await clearPlugins();
    const response = await invokeLlmsTxt();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, s-maxage=3600",
    );
  });

  it("includes H1, blockquote, and published plugin names when data exists", async () => {
    await clearPlugins();
    await seedPlugin("alpha", "Alpha Plugin", 100, "published");
    await seedPlugin("beta", "Beta Plugin", 50, "published");
    await seedPlugin("gamma", "Gamma Plugin", 10, "published");

    const response = await invokeLlmsTxt();
    const body = await response.text();

    expect(body).toContain("# EmDash CMS Marketplace");
    expect(body).toMatch(/\n> /);
    expect(body).toContain("Alpha Plugin");
    expect(body).toContain("Beta Plugin");
    expect(body).toContain("Gamma Plugin");
    expect(body).toContain("## Featured Plugins");
  });

  it("excludes plugins whose only version is rejected (failed audit)", async () => {
    await clearPlugins();
    await seedPlugin("fail-me", "Fail Me", 500, "rejected");
    await seedPlugin("pass-me", "Pass Me", 100, "published");

    const response = await invokeLlmsTxt();
    const body = await response.text();

    expect(body).toContain("Pass Me");
    expect(body).not.toContain("Fail Me");
  });

  it("emits only the header, summary, and API section when the catalog is empty", async () => {
    await clearPlugins();
    const response = await invokeLlmsTxt();
    const body = await response.text();

    expect(body).toContain("# EmDash CMS Marketplace");
    expect(body).toContain("## API");
    expect(body).not.toContain("## Featured Plugins");
    expect(body).not.toContain("## Recently Updated Plugins");
    expect(body).not.toContain("## Themes");
  });
});
