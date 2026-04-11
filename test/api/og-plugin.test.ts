/**
 * Integration tests for /og/plugin/[id].png (AIDX-05).
 *
 * These tests drive the route handler directly — they do NOT invoke
 * the `workers-og` render pipeline. The request-path route is a
 * thin R2 proxy that enqueues an OG_QUEUE job on cache miss and
 * returns a placeholder PNG; the actual render runs in the queue
 * consumer, which is covered by `test/lib/seo/og-image.test.ts`.
 *
 * The cache key scheme under test:
 *   `og/plugin/{pluginId}/{latestVersion}.png`
 *
 * We exercise:
 *   1. 404 for unknown plugin.
 *   2. Cache miss → placeholder + enqueue.
 *   3. Cache hit → R2 body + immutable headers, NO enqueue.
 *   4. Version-keyed: hitting the wrong version key is a cache miss.
 *   5. Queue send failure still returns the placeholder (no 500).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { GET } from "../../src/pages/og/plugin/[id].png";
import { PLACEHOLDER_PNG } from "../../src/lib/seo/og-image";

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean slate for this test file's entity namespace. Other tests
  // use different `author_id` prefixes so there's no collision.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB.exec(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('author-og-plugin', 9001, 'og-plugin-author', NULL, 1, '2026-01-10T08:00:00Z', '2026-03-20T12:00:00Z');",
  );
});

async function seedPlugin(id: string, version: string) {
  await env.DB.prepare(
    "INSERT INTO plugins (id, author_id, name, short_description, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "author-og-plugin",
      `Plugin ${id}`,
      `OG test fixture for ${id}`,
      null,
      "content",
      "[]",
      "[]",
      null,
      null,
      null,
      "MIT",
      100,
      "2026-01-15T10:00:00Z",
      "2026-03-20T12:00:00Z",
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `pv-${id}-${version}`,
      id,
      version,
      "published",
      `bundles/${id}/${version}.tar.gz`,
      `{"id":"${id}","version":"${version}","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}`,
      3,
      10000,
      25000,
      null,
      "sha256:" + "a".repeat(8),
      null,
      null,
      "2026-01-20T12:00:00Z",
      "2026-01-20T10:00:00Z",
      "2026-01-20T12:00:00Z",
    )
    .run();
}

async function clearCatalog() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins WHERE id LIKE 'og-%'"),
  ]);
}

/**
 * Delete every `og/plugin/*` object from the test R2 binding so
 * tests can't leak cache state into each other.
 */
async function clearOgR2() {
  const list = await env.ARTIFACTS.list({ prefix: "og/plugin/" });
  if (list.objects.length > 0) {
    await env.ARTIFACTS.delete(list.objects.map((o) => o.key));
  }
}

async function invokeGet(id: string | undefined): Promise<Response> {
  const url = `https://emdashcms.org/og/plugin/${id ?? ""}.png`;
  return (
    GET as unknown as (ctx: {
      request: Request;
      params: { id: string | undefined };
    }) => Promise<Response>
  )({
    request: new Request(url, { method: "GET" }),
    params: { id },
  });
}

function isPngBody(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/og/plugin/[id].png endpoint", () => {
  beforeEach(async () => {
    await clearCatalog();
    await clearOgR2();
    vi.restoreAllMocks();
  });

  it("returns 404 when the plugin does not exist", async () => {
    const response = await invokeGet("og-missing");
    expect(response.status).toBe(404);
  });

  it("cache miss: returns the placeholder PNG and enqueues an OG_QUEUE job", async () => {
    await seedPlugin("og-miss", "1.0.0");
    const sendSpy = vi.spyOn(env.OG_QUEUE, "send");

    const response = await invokeGet("og-miss");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    // Placeholder uses a short cache so crawlers re-fetch after the
    // queue consumer finishes.
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(isPngBody(body)).toBe(true);
    expect(body.byteLength).toBe(PLACEHOLDER_PNG.byteLength);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      kind: "plugin",
      id: "og-miss",
      version: "1.0.0",
    });
  });

  it("cache hit: streams the R2 body with immutable cache headers and does NOT enqueue", async () => {
    await seedPlugin("og-hit", "1.2.3");
    // Pre-populate R2 with a fake PNG body so the route short-
    // circuits onto the hot path.
    const fakePng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
    ]);
    await env.ARTIFACTS.put("og/plugin/og-hit/1.2.3.png", fakePng, {
      httpMetadata: { contentType: "image/png" },
    });
    const sendSpy = vi.spyOn(env.OG_QUEUE, "send");

    const response = await invokeGet("og-hit");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(fakePng);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("version-keyed: pre-populating the wrong version key still cache-misses", async () => {
    // The plugin's latest version is 2.0.0, but R2 only holds the
    // 1.0.0 image. The route computes the key from the latest version,
    // so this is a cache MISS and the response is the placeholder.
    await seedPlugin("og-ver", "2.0.0");
    await env.ARTIFACTS.put(
      "og/plugin/og-ver/1.0.0.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      { httpMetadata: { contentType: "image/png" } },
    );
    const sendSpy = vi.spyOn(env.OG_QUEUE, "send");

    const response = await invokeGet("og-ver");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(sendSpy).toHaveBeenCalledWith({
      kind: "plugin",
      id: "og-ver",
      version: "2.0.0",
    });
  });

  it("queue send failure: still returns the placeholder (no 500)", async () => {
    await seedPlugin("og-queue-fail", "1.0.0");
    vi.spyOn(env.OG_QUEUE, "send").mockImplementation(async () => {
      throw new Error("simulated queue outage");
    });

    const response = await invokeGet("og-queue-fail");

    // The point of the defensive try/catch in the route is that a
    // queue outage must never 500 the OG endpoint — social crawlers
    // would start rendering broken link cards otherwise.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(isPngBody(body)).toBe(true);
  });
});
