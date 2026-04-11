/**
 * Integration tests for /og/theme/[id].png (AIDX-06).
 *
 * Mirror of test/api/og-plugin.test.ts. Themes have no version
 * concept, so the cache key uses
 * `Math.floor(Date.parse(theme.updatedAt) / 1000)` as the
 * immutability marker. Same R2-proxy + queue-enqueue-on-miss flow.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { GET } from "../../src/pages/og/theme/[id].png";
import { PLACEHOLDER_PNG } from "../../src/lib/seo/og-image";

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const THEME_UPDATED_AT = "2026-03-20T12:00:00Z";
const THEME_UPDATED_AT_EPOCH = Math.floor(
  Date.parse(THEME_UPDATED_AT) / 1000,
);

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare(
      "DELETE FROM authors WHERE github_username = 'og-theme-author'",
    ),
  ]);

  await env.DB.exec(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('author-og-theme', 9002, 'og-theme-author', NULL, 1, '2026-01-10T08:00:00Z', '2026-03-20T12:00:00Z');",
  );
});

async function seedTheme(id: string, updatedAt: string) {
  await env.DB.prepare(
    "INSERT INTO themes (id, author_id, name, short_description, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "author-og-theme",
      `Theme ${id}`,
      `OG test fixture theme ${id}`,
      null,
      '["minimal","editorial"]',
      "https://github.com/og-theme-author/" + id,
      null,
      null,
      `@og-themes/${id}`,
      null,
      null,
      "MIT",
      "2026-01-15T10:00:00Z",
      updatedAt,
    )
    .run();
}

async function clearThemes() {
  await env.DB.prepare("DELETE FROM themes WHERE id LIKE 'og-%'").run();
}

async function clearOgR2() {
  const list = await env.ARTIFACTS.list({ prefix: "og/theme/" });
  if (list.objects.length > 0) {
    await env.ARTIFACTS.delete(list.objects.map((o) => o.key));
  }
}

async function invokeGet(id: string | undefined): Promise<Response> {
  const url = `https://emdashcms.org/og/theme/${id ?? ""}.png`;
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

describe("/og/theme/[id].png endpoint", () => {
  beforeEach(async () => {
    await clearThemes();
    await clearOgR2();
    vi.restoreAllMocks();
  });

  it("returns 404 when the theme does not exist", async () => {
    const response = await invokeGet("og-missing");
    expect(response.status).toBe(404);
  });

  it("cache miss: returns the placeholder PNG and enqueues an OG_QUEUE job keyed by updatedAt epoch", async () => {
    await seedTheme("og-theme-miss", THEME_UPDATED_AT);
    const sendSpy = vi.spyOn(env.OG_QUEUE, "send");

    const response = await invokeGet("og-theme-miss");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(isPngBody(body)).toBe(true);
    expect(body.byteLength).toBe(PLACEHOLDER_PNG.byteLength);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      kind: "theme",
      id: "og-theme-miss",
      updatedAtEpoch: THEME_UPDATED_AT_EPOCH,
    });
  });

  it("cache hit: streams the R2 body with immutable cache headers and does NOT enqueue", async () => {
    await seedTheme("og-theme-hit", THEME_UPDATED_AT);
    const fakePng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xca, 0xfe, 0xba, 0xbe,
    ]);
    const key = `og/theme/og-theme-hit/${THEME_UPDATED_AT_EPOCH}.png`;
    await env.ARTIFACTS.put(key, fakePng, {
      httpMetadata: { contentType: "image/png" },
    });
    const sendSpy = vi.spyOn(env.OG_QUEUE, "send");

    const response = await invokeGet("og-theme-hit");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(fakePng);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("epoch-keyed: a stale R2 image under the wrong epoch is a cache miss", async () => {
    // Theme was updated just now, but R2 only holds the image from an
    // older epoch. The route computes the key from the current
    // updatedAt, so this is a cache MISS.
    await seedTheme("og-theme-ver", THEME_UPDATED_AT);
    const staleEpoch = THEME_UPDATED_AT_EPOCH - 86_400; // 1 day older
    await env.ARTIFACTS.put(
      `og/theme/og-theme-ver/${staleEpoch}.png`,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      { httpMetadata: { contentType: "image/png" } },
    );
    const sendSpy = vi.spyOn(env.OG_QUEUE, "send");

    const response = await invokeGet("og-theme-ver");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(sendSpy).toHaveBeenCalledWith({
      kind: "theme",
      id: "og-theme-ver",
      updatedAtEpoch: THEME_UPDATED_AT_EPOCH,
    });
  });

  it("queue send failure: still returns the placeholder (no 500)", async () => {
    await seedTheme("og-theme-fail", THEME_UPDATED_AT);
    vi.spyOn(env.OG_QUEUE, "send").mockImplementation(async () => {
      throw new Error("simulated queue outage");
    });

    const response = await invokeGet("og-theme-fail");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(isPngBody(body)).toBe(true);
  });
});
