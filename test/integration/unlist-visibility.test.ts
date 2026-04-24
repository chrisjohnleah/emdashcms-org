import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  unlistPlugin,
  relistPlugin,
  deprecatePlugin,
} from "../../src/lib/publishing/deprecation-queries";
import { searchPlugins, getPluginDetail } from "../../src/lib/db/queries";
import { GET as bundleGET } from "../../src/pages/api/v1/plugins/[id]/versions/[version]/bundle";

/**
 * Phase 17 integration tests — unlist visibility invariants (DEPR-07).
 *
 * Unlisted plugins:
 *   - MUST be hidden from search results and category browsing.
 *   - MUST still resolve via getPluginDetail at their direct /plugins/:id URL.
 *   - MUST still serve bundle downloads so existing installs keep working.
 *   - unlist/relist MUST be idempotent.
 *
 * Plan note: the "download-still-works" assertion also reinforces DEPR-04
 * by extension — we run the same bundle check against a deprecated plugin
 * inside install-deprecation-warning.test.ts. Here we focus on the unlist
 * axis so each test has a single reason to fail.
 */

const AUTHOR_ID = "int17-un-alice";
const AUTHOR_GITHUB_ID = 910400;

const PLUGIN_HIDDEN = "int17-un-hidden";
const PLUGIN_VISIBLE = "int17-un-visible";
const PLUGIN_BUNDLE = "int17-un-bundle";
const PLUGIN_TOGGLE = "int17-un-toggle";
const BUNDLE_KEY = `bundles/${PLUGIN_BUNDLE}/1.0.0.tar.gz`;
const TEST_BUNDLE_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x99]);

async function seedAuthor(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors
       (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(AUTHOR_ID, AUTHOR_GITHUB_ID, "int17-un-alice")
    .run();
}

async function seedPlugin(id: string, name: string, bundleKey?: string): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO plugins
           (id, author_id, name, description, capabilities, keywords,
            installs_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', '[]', 0,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(id, AUTHOR_ID, name, `${name} description`),
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO plugin_versions
           (id, plugin_id, version, status, bundle_key, manifest,
            file_count, compressed_size, decompressed_size, checksum,
            screenshots, retry_count, source, created_at, updated_at)
         VALUES (?, ?, '1.0.0', 'published', ?, '{}',
                 1, 100, 500, 'int17-un-checksum',
                 '[]', 0, 'upload',
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(`ver-${id}`, id, bundleKey ?? `bundles/${id}/1.0.0.tar.gz`),
  ]);
}

async function wipePlugin(id: string): Promise<void> {
  // Four tables FK into plugins(id): plugin_versions, installs,
  // plugin_github_links, download_dedup. Plus the self-referential
  // successor_id on plugins itself (added in 0025). Clear all of them
  // so the plugins DELETE never trips SQLITE_CONSTRAINT_FOREIGNKEY.
  await env.DB.batch([
    env.DB
      .prepare("UPDATE plugins SET successor_id = NULL WHERE successor_id = ?")
      .bind(id),
    env.DB.prepare("DELETE FROM plugin_versions WHERE plugin_id = ?").bind(id),
    env.DB.prepare("DELETE FROM installs WHERE plugin_id = ?").bind(id),
    env.DB
      .prepare("DELETE FROM plugin_github_links WHERE plugin_id = ?")
      .bind(id),
    env.DB.prepare("DELETE FROM download_dedup WHERE plugin_id = ?").bind(id),
    env.DB.prepare("DELETE FROM plugins WHERE id = ?").bind(id),
  ]);
}

type LocalsShape = App.Locals;

function makeBundleRequest(pluginId: string, version: string): Request {
  return new Request(
    `https://example.org/api/v1/plugins/${pluginId}/versions/${version}/bundle`,
    {
      method: "GET",
      headers: { "CF-Connecting-IP": "203.0.113.50" },
    },
  );
}

async function invokeBundle(pluginId: string, version: string): Promise<Response> {
  return (bundleGET as unknown as (ctx: {
    params: Record<string, string>;
    request: Request;
    locals: LocalsShape;
  }) => Promise<Response>)({
    params: { id: pluginId, version },
    request: makeBundleRequest(pluginId, version),
    // The handler calls `locals.cfContext?.waitUntil?.()` to fire-and-forget
    // download tracking. A minimal stub matches that optional-chain contract
    // without requiring a real ExecutionContext.
    locals: { cfContext: { waitUntil: () => {} } } as unknown as LocalsShape,
  });
}

beforeAll(async () => {
  await seedAuthor();
  // Persist the R2 object once for the bundle-download assertion.
  await env.ARTIFACTS.put(BUNDLE_KEY, TEST_BUNDLE_BYTES, {
    httpMetadata: { contentType: "application/gzip" },
  });
});

beforeEach(async () => {
  for (const id of [PLUGIN_HIDDEN, PLUGIN_VISIBLE, PLUGIN_BUNDLE, PLUGIN_TOGGLE]) {
    await wipePlugin(id);
  }
});

describe("Phase 17 — unlist visibility", () => {
  it("unlisted plugin disappears from searchPlugins results", async () => {
    await seedPlugin(PLUGIN_HIDDEN, "Hidden Plugin");
    await seedPlugin(PLUGIN_VISIBLE, "Visible Plugin");

    await unlistPlugin(env.DB, PLUGIN_HIDDEN, AUTHOR_ID);

    const page = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 50,
    });

    const ids = page.items.map((i) => i.id);
    expect(ids).not.toContain(PLUGIN_HIDDEN);
    expect(ids).toContain(PLUGIN_VISIBLE);
  });

  it("unlisted plugin remains reachable via getPluginDetail (direct /plugins/:id URL)", async () => {
    await seedPlugin(PLUGIN_HIDDEN, "Hidden Plugin");
    await unlistPlugin(env.DB, PLUGIN_HIDDEN, AUTHOR_ID);

    const detail = await getPluginDetail(env.DB, PLUGIN_HIDDEN);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(PLUGIN_HIDDEN);
    expect(detail?.unlisted).toBe(true);
  });

  it("unlisted plugin's bundle download path still serves 200 with the bundle bytes", async () => {
    await seedPlugin(PLUGIN_BUNDLE, "Bundle Plugin", BUNDLE_KEY);
    await unlistPlugin(env.DB, PLUGIN_BUNDLE, AUTHOR_ID);

    const res = await invokeBundle(PLUGIN_BUNDLE, "1.0.0");
    // Critical DEPR-07 invariant: the download path is NOT gated on
    // unlisted_at. If this ever returns 404 or 410 the download
    // endpoint has been broken.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(410);
    expect(res.headers.get("content-type")).toBe("application/gzip");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(TEST_BUNDLE_BYTES.length);
    expect(bytes[0]).toBe(0x1f);
  });

  it("unlist is idempotent and relist clears unlisted_at", async () => {
    await seedPlugin(PLUGIN_TOGGLE, "Toggle Plugin");

    await unlistPlugin(env.DB, PLUGIN_TOGGLE, AUTHOR_ID);
    await unlistPlugin(env.DB, PLUGIN_TOGGLE, AUTHOR_ID); // second call — no-op
    await relistPlugin(env.DB, PLUGIN_TOGGLE);

    const row = await env.DB
      .prepare("SELECT unlisted_at, unlisted_by FROM plugins WHERE id = ?")
      .bind(PLUGIN_TOGGLE)
      .first<{ unlisted_at: string | null; unlisted_by: string | null }>();
    expect(row?.unlisted_at).toBeNull();
    expect(row?.unlisted_by).toBeNull();
  });

  it("relisting a previously unlisted plugin returns it to searchPlugins", async () => {
    await seedPlugin(PLUGIN_TOGGLE, "Toggle Plugin");
    await unlistPlugin(env.DB, PLUGIN_TOGGLE, AUTHOR_ID);
    await relistPlugin(env.DB, PLUGIN_TOGGLE);

    const page = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 50,
    });
    expect(page.items.map((i) => i.id)).toContain(PLUGIN_TOGGLE);
  });

  // Defensive: deprecation and unlist are orthogonal. A plugin can be both
  // (e.g. owner deprecated it months ago and now wants to fully hide it
  // from discovery). The search query must hide unlisted even when
  // deprecated_at is set — the unlist filter wins.
  it("a deprecated AND unlisted plugin is hidden from search (unlist wins over demote)", async () => {
    await seedPlugin(PLUGIN_HIDDEN, "Hidden Plugin");
    await deprecatePlugin(env.DB, {
      pluginId: PLUGIN_HIDDEN,
      actorAuthorId: AUTHOR_ID,
      category: "abandoned",
    });
    await unlistPlugin(env.DB, PLUGIN_HIDDEN, AUTHOR_ID);

    const page = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 50,
    });
    expect(page.items.map((i) => i.id)).not.toContain(PLUGIN_HIDDEN);
  });
});
