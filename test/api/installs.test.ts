import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { POST } from "../../src/pages/api/v1/plugins/[id]/installs";
import { deprecatePlugin } from "../../src/lib/publishing/deprecation-queries";

// ---------------------------------------------------------------------------
// Seed: three plugins — active, deprecated (no successor), deprecated (with
// live successor). Each has one published version so pluginExists+trackInstall
// accept the request.
// ---------------------------------------------------------------------------

const AUTHOR_ID = "inst-alice";

async function seedPlugin(id: string, name: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugins
       (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', '[]', 0,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(id, AUTHOR_ID, name, `${name} desc`)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugin_versions
       (id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, checksum,
        screenshots, retry_count, source, created_at, updated_at)
     VALUES (?, ?, '1.0.0', 'published', ?, '{}',
             1, 100, 500, 'inst-sum',
             '[]', 0, 'upload',
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(`ver-inst-${id}`, id, `bundles/${id}/1.0.0.tar.gz`)
    .run();
}

const VALID_SITE_HASH = "a".repeat(64);
const BODY = JSON.stringify({ siteHash: VALID_SITE_HASH, version: "1.0.0" });

function buildRequest(): Request {
  return new Request("https://example.org/api/v1/plugins/placeholder/installs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": "203.0.113.9",
    },
    body: BODY,
  });
}

async function invoke(pluginId: string) {
  // Astro's APIRoute signature: { params, request, ... } — only `params` and
  // `request` are read by the installs handler, so we pass just those.
  return (POST as unknown as (ctx: {
    params: Record<string, string>;
    request: Request;
  }) => Promise<Response>)({
    params: { id: pluginId },
    request: buildRequest(),
  });
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors
       (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(AUTHOR_ID, 900200, "inst-alice")
    .run();

  await seedPlugin("inst-active", "Inst Active");
  await seedPlugin("inst-dep-no-succ", "Inst Deprecated Solo");
  await seedPlugin("inst-dep-with-succ", "Inst Deprecated With Successor");
  await seedPlugin("inst-successor", "Inst Successor");

  const r1 = await deprecatePlugin(env.DB, {
    pluginId: "inst-dep-no-succ",
    actorAuthorId: AUTHOR_ID,
    category: "unmaintained",
    note: "No longer maintained.",
  });
  expect(r1).toEqual({ ok: true });

  const r2 = await deprecatePlugin(env.DB, {
    pluginId: "inst-dep-with-succ",
    actorAuthorId: AUTHOR_ID,
    category: "replaced",
    note: "Use the successor.",
    successorId: "inst-successor",
  });
  expect(r2).toEqual({ ok: true });
});

describe("POST /api/v1/plugins/:id/installs — deprecationWarning", () => {
  it("returns 202 with an empty body for an active plugin", async () => {
    const res = await invoke("inst-active");
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("returns 202 with deprecationWarning JSON for a deprecated plugin", async () => {
    const res = await invoke("inst-dep-no-succ");
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      deprecationWarning: {
        category: string;
        reason: string;
        successor?: unknown;
      };
    };
    expect(body.deprecationWarning.category).toBe("unmaintained");
    expect(body.deprecationWarning.reason).toBe("No longer maintained.");
    expect(body.deprecationWarning.successor).toBeUndefined();
  });

  it("embeds successor { id, name, url } when the deprecation has a live successor", async () => {
    const res = await invoke("inst-dep-with-succ");
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      deprecationWarning: {
        category: string;
        reason: string;
        successor?: { id: string; name: string; url: string };
      };
    };
    expect(body.deprecationWarning.category).toBe("replaced");
    expect(body.deprecationWarning.successor).toEqual({
      id: "inst-successor",
      name: "Inst Successor",
      url: "/plugins/inst-successor",
    });
  });
});
