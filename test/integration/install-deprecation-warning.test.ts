import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { POST as installsPOST } from "../../src/pages/api/v1/plugins/[id]/installs";
import {
  deprecatePlugin,
  undeprecatePlugin,
  unlistPlugin,
} from "../../src/lib/publishing/deprecation-queries";

/**
 * Phase 17 integration tests — install endpoint deprecation warning (DEPR-05).
 *
 * Pins the public wire shape consumed by the EmDash core CLI:
 *   { deprecationWarning: { reason, category, successor?: { id, name, url } } }
 *
 * Active plugins preserve the pre-Phase-17 compact empty-body 202 so old
 * CLI builds that ignore the response body remain compatible.
 *
 * Test 4 specifically exercises the broken-chain defence: a deprecation
 * pointing at a now-unlisted successor must not 500 and must not emit a
 * dead successor link — the install endpoint should gracefully drop the
 * successor field.
 */

const AUTHOR_ID = "int17-inst-alice";
const AUTHOR_GITHUB_ID = 910500;

const VALID_SITE_HASH = "b".repeat(64);
const INSTALL_BODY = JSON.stringify({
  siteHash: VALID_SITE_HASH,
  version: "1.0.0",
});

const P_ACTIVE = "int17-inst-active";
const P_DEP_NO_SUCC = "int17-inst-dep-solo";
const P_DEP_WITH_SUCC = "int17-inst-dep-replaced";
const P_SUCC = "int17-inst-succ";
const P_DEP_BROKEN = "int17-inst-dep-broken";
const P_SUCC_BROKEN = "int17-inst-succ-broken";
const P_RESTORED = "int17-inst-restored";

async function seedAuthor(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors
       (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(AUTHOR_ID, AUTHOR_GITHUB_ID, "int17-inst-alice")
    .run();
}

async function seedPlugin(id: string, name: string): Promise<void> {
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
                 1, 100, 500, 'int17-inst-checksum',
                 '[]', 0, 'upload',
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(`ver-${id}`, id, `bundles/${id}/1.0.0.tar.gz`),
  ]);
}

async function wipePlugin(id: string): Promise<void> {
  // Clear every FK into plugins(id) — successor_id self-ref plus the
  // four child tables (plugin_versions, installs, plugin_github_links,
  // download_dedup). Keeps the plugins DELETE FK-safe even when an
  // earlier test left a successor pointer or a bundle tracking row.
  await env.DB.batch([
    env.DB
      .prepare("UPDATE plugins SET successor_id = NULL WHERE successor_id = ?")
      .bind(id),
    env.DB.prepare("DELETE FROM installs WHERE plugin_id = ?").bind(id),
    env.DB.prepare("DELETE FROM plugin_versions WHERE plugin_id = ?").bind(id),
    env.DB
      .prepare("DELETE FROM plugin_github_links WHERE plugin_id = ?")
      .bind(id),
    env.DB.prepare("DELETE FROM download_dedup WHERE plugin_id = ?").bind(id),
    env.DB.prepare("DELETE FROM plugins WHERE id = ?").bind(id),
  ]);
}

function buildRequest(ipSuffix: string): Request {
  return new Request(
    "https://example.org/api/v1/plugins/placeholder/installs",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Different IP per test so the 10/min rate limit never trips
        // across the full suite.
        "CF-Connecting-IP": `203.0.113.${ipSuffix}`,
      },
      body: INSTALL_BODY,
    },
  );
}

async function invokeInstall(
  pluginId: string,
  ipSuffix: string,
): Promise<Response> {
  return (installsPOST as unknown as (ctx: {
    params: Record<string, string>;
    request: Request;
  }) => Promise<Response>)({
    params: { id: pluginId },
    request: buildRequest(ipSuffix),
  });
}

type DeprecationBody = {
  deprecationWarning: {
    category: string;
    reason: string;
    successor?: { id: string; name: string; url: string };
  };
};

const ALL_IDS = [
  P_ACTIVE,
  P_DEP_NO_SUCC,
  P_DEP_WITH_SUCC,
  P_SUCC,
  P_DEP_BROKEN,
  P_SUCC_BROKEN,
  P_RESTORED,
];

beforeAll(async () => {
  await seedAuthor();
});

beforeEach(async () => {
  // Wipe and reseed every test so rate-limit rows and prior install
  // counts don't bleed. The install endpoint limits to 10/min/IP; each
  // test uses its own IP suffix anyway, but rate_limits still
  // accumulates over the suite — cheaper to clear.
  await env.DB.prepare("DELETE FROM rate_limits").run();
  for (const id of ALL_IDS) {
    await wipePlugin(id);
  }
  for (const [id, name] of [
    [P_ACTIVE, "Active"],
    [P_DEP_NO_SUCC, "Deprecated Solo"],
    [P_DEP_WITH_SUCC, "Deprecated With Successor"],
    [P_SUCC, "Successor"],
    [P_DEP_BROKEN, "Deprecated Broken"],
    [P_SUCC_BROKEN, "Successor Broken"],
    [P_RESTORED, "Restored"],
  ] as const) {
    await seedPlugin(id, name);
  }
});

describe("Phase 17 — install endpoint deprecation warning", () => {
  it("active plugin install returns 202 with an empty body", async () => {
    const res = await invokeInstall(P_ACTIVE, "10");
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("deprecated plugin without successor returns deprecationWarning with null/undefined successor", async () => {
    const setup = await deprecatePlugin(env.DB, {
      pluginId: P_DEP_NO_SUCC,
      actorAuthorId: AUTHOR_ID,
      category: "abandoned",
      note: "upstream closed shop",
    });
    expect(setup).toEqual({ ok: true });

    const res = await invokeInstall(P_DEP_NO_SUCC, "11");
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as DeprecationBody;
    expect(body.deprecationWarning.category).toBe("abandoned");
    expect(body.deprecationWarning.reason).toBe("upstream closed shop");
    expect(body.deprecationWarning.successor).toBeUndefined();
  });

  it("deprecated plugin with successor embeds { id, name, url } and falls back to 'has been replaced' when note is null", async () => {
    const setup = await deprecatePlugin(env.DB, {
      pluginId: P_DEP_WITH_SUCC,
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      // note intentionally omitted so the CLI fallback label surfaces
      successorId: P_SUCC,
    });
    expect(setup).toEqual({ ok: true });

    const res = await invokeInstall(P_DEP_WITH_SUCC, "12");
    expect(res.status).toBe(202);

    const body = (await res.json()) as DeprecationBody;
    expect(body.deprecationWarning.category).toBe("replaced");
    // When no note is set, the 17-01 fallback label map emits this copy
    // verbatim — stable contract the CLI renders under "Deprecation
    // warning: ".
    expect(body.deprecationWarning.reason).toBe("has been replaced");
    expect(body.deprecationWarning.successor).toEqual({
      id: P_SUCC,
      name: "Successor",
      url: `/plugins/${P_SUCC}`,
    });
  });

  it("broken successor chain (successor unlisted after the fact) does not 500 and omits the successor field", async () => {
    const setup = await deprecatePlugin(env.DB, {
      pluginId: P_DEP_BROKEN,
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      note: "Use the fork",
      successorId: P_SUCC_BROKEN,
    });
    expect(setup).toEqual({ ok: true });

    // Now break the chain — unlist the successor AFTER the deprecation
    // wrote. The install-warning resolver must drop the dead link
    // rather than point CLI users at a hidden plugin.
    await unlistPlugin(env.DB, P_SUCC_BROKEN, AUTHOR_ID);

    const res = await invokeInstall(P_DEP_BROKEN, "13");
    expect(res.status).toBe(202);
    expect(res.status).not.toBe(500);

    const body = (await res.json()) as DeprecationBody;
    expect(body.deprecationWarning.category).toBe("replaced");
    expect(body.deprecationWarning.successor).toBeUndefined();
    // The note survives regardless of successor resolution.
    expect(body.deprecationWarning.reason).toBe("Use the fork");
  });

  it("un-deprecate round-trip removes the deprecationWarning body", async () => {
    await deprecatePlugin(env.DB, {
      pluginId: P_RESTORED,
      actorAuthorId: AUTHOR_ID,
      category: "unmaintained",
      note: "temporary",
    });
    // Sanity check: deprecated plugin produces a JSON body.
    const deprecatedRes = await invokeInstall(P_RESTORED, "14");
    expect(deprecatedRes.status).toBe(202);
    expect(deprecatedRes.headers.get("content-type")).toContain(
      "application/json",
    );

    await undeprecatePlugin(env.DB, P_RESTORED, AUTHOR_ID);

    const restoredRes = await invokeInstall(P_RESTORED, "15");
    expect(restoredRes.status).toBe(202);
    const text = await restoredRes.text();
    expect(text).toBe(""); // back on the compact hot path
  });
});
