import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  deprecatePlugin,
  undeprecatePlugin,
  unlistPlugin,
  relistPlugin,
  detectSuccessorCycle,
  searchSuccessorCandidates,
  getDeprecationWarning,
} from "../../src/lib/publishing/deprecation-queries";

// ---------------------------------------------------------------------------
// Seed data — dedicated author + plugin ids so tests don't collide with
// other suites' fixtures. All plugin rows get one published version so they
// would normally be searchable.
// ---------------------------------------------------------------------------

const AUTHOR_ID = "dep-alice";

async function seedPlugin(id: string, name: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugins
       (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', '[]', 0,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(id, AUTHOR_ID, name, `${name} description`)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugin_versions
       (id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, checksum,
        screenshots, retry_count, source, created_at, updated_at)
     VALUES (?, ?, '1.0.0', 'published', ?, '{}',
             1, 100, 500, 'dep-checksum',
             '[]', 0, 'upload',
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(`ver-${id}`, id, `bundles/${id}/1.0.0.tar.gz`)
    .run();
}

async function resetPluginState(id: string) {
  await env.DB.prepare(
    `UPDATE plugins
       SET deprecated_at = NULL,
           deprecated_by = NULL,
           deprecated_reason_category = NULL,
           deprecated_reason_note = NULL,
           successor_id = NULL,
           unlisted_at = NULL,
           unlisted_by = NULL
     WHERE id = ?`,
  )
    .bind(id)
    .run();
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors
       (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(AUTHOR_ID, 900100, "dep-alice")
    .run();

  for (const [id, name] of [
    ["dep-a", "Plugin A"],
    ["dep-b", "Plugin B"],
    ["dep-c", "Plugin C"],
    ["dep-d", "Plugin D"],
    ["dep-e", "Plugin E"],
  ] as const) {
    await seedPlugin(id, name);
  }
});

beforeEach(async () => {
  for (const id of ["dep-a", "dep-b", "dep-c", "dep-d", "dep-e"]) {
    await resetPluginState(id);
  }
});

describe("detectSuccessorCycle", () => {
  it("rejects direct A->B->A cycle", async () => {
    // Set up B -> A (successor of B is A). Now asking "can A point to B?"
    // must return true (cycle).
    await env.DB.prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
      .bind("dep-a", "dep-b")
      .run();

    const hasCycle = await detectSuccessorCycle(env.DB, "dep-a", "dep-b");
    expect(hasCycle).toBe(true);
  });

  it("rejects 4-node cycle D->E->A->D", async () => {
    // Seed chain: E -> A, A -> D. Asking "can D point to E?" must return
    // true because E -> A -> D closes the cycle back to D.
    await env.DB.batch([
      env.DB
        .prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
        .bind("dep-a", "dep-e"),
      env.DB
        .prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
        .bind("dep-d", "dep-a"),
    ]);

    const hasCycle = await detectSuccessorCycle(env.DB, "dep-d", "dep-e");
    expect(hasCycle).toBe(true);
  });

  it("accepts a legitimate chain A->B (B has no successor)", async () => {
    const hasCycle = await detectSuccessorCycle(env.DB, "dep-a", "dep-b");
    expect(hasCycle).toBe(false);
  });

  it("respects max depth 10 as a safety rail", async () => {
    // Build a 12-hop chain p0 -> p1 -> ... -> p11. Asking "can origin
    // point to p0?" should return true because the walk hits the depth
    // cap before determining the chain terminates cleanly — the safety
    // rail treats an over-long chain as a cycle.
    const chainIds = Array.from({ length: 12 }, (_, i) => `dep-chain-${i}`);
    for (const id of chainIds) {
      await seedPlugin(id, `Chain ${id}`);
      await resetPluginState(id);
    }
    for (let i = 0; i < chainIds.length - 1; i++) {
      await env.DB
        .prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
        .bind(chainIds[i + 1], chainIds[i])
        .run();
    }

    const hasCycle = await detectSuccessorCycle(env.DB, "dep-a", chainIds[0]);
    expect(hasCycle).toBe(true);
  });
});

describe("deprecatePlugin", () => {
  it("rejects an unknown category", async () => {
    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      // @ts-expect-error — intentionally invalid category for the test
      category: "nope",
    });
    expect(result).toEqual({ ok: false, error: "invalid_category" });
  });

  it("rejects a note longer than 500 chars after trim", async () => {
    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "unmaintained",
      note: "x".repeat(501),
    });
    expect(result).toEqual({ ok: false, error: "note_too_long" });
  });

  it("treats a whitespace-only note as null and succeeds", async () => {
    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "abandoned",
      note: "   \n  \t  ",
    });
    expect(result).toEqual({ ok: true });

    const row = await env.DB
      .prepare(
        "SELECT deprecated_reason_note FROM plugins WHERE id = ?",
      )
      .bind("dep-a")
      .first<{ deprecated_reason_note: string | null }>();
    expect(row?.deprecated_reason_note).toBeNull();
  });

  it("rejects self-reference in successor_id", async () => {
    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "dep-a",
    });
    expect(result).toEqual({ ok: false, error: "successor_self" });
  });

  it("rejects a successor that is itself already deprecated", async () => {
    await env.DB.prepare(
      `UPDATE plugins
         SET deprecated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             deprecated_reason_category = 'unmaintained'
       WHERE id = 'dep-b'`,
    ).run();

    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "dep-b",
    });
    expect(result).toEqual({ ok: false, error: "successor_deprecated" });
  });

  it("rejects a successor that is unlisted", async () => {
    await env.DB.prepare(
      `UPDATE plugins
         SET unlisted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = 'dep-b'`,
    ).run();

    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "dep-b",
    });
    expect(result).toEqual({ ok: false, error: "successor_unlisted" });
  });

  it("rejects an unknown successor id", async () => {
    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "does-not-exist",
    });
    expect(result).toEqual({ ok: false, error: "successor_not_found" });
  });

  it("writes all columns atomically and bumps updated_at on success", async () => {
    const before = await env.DB
      .prepare("SELECT updated_at FROM plugins WHERE id = ?")
      .bind("dep-a")
      .first<{ updated_at: string }>();

    // Nudge a second so strftime('now') is strictly greater.
    await new Promise((r) => setTimeout(r, 1100));

    const result = await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      note: "  See the new plugin.  ",
      successorId: "dep-b",
    });
    expect(result).toEqual({ ok: true });

    const after = await env.DB
      .prepare(
        `SELECT deprecated_at, deprecated_by, deprecated_reason_category,
                deprecated_reason_note, successor_id, updated_at
         FROM plugins WHERE id = ?`,
      )
      .bind("dep-a")
      .first<{
        deprecated_at: string | null;
        deprecated_by: string | null;
        deprecated_reason_category: string | null;
        deprecated_reason_note: string | null;
        successor_id: string | null;
        updated_at: string;
      }>();
    expect(after?.deprecated_at).not.toBeNull();
    expect(after?.deprecated_by).toBe(AUTHOR_ID);
    expect(after?.deprecated_reason_category).toBe("replaced");
    expect(after?.deprecated_reason_note).toBe("See the new plugin.");
    expect(after?.successor_id).toBe("dep-b");
    expect(after && before && after.updated_at > before.updated_at).toBe(true);
  });
});

describe("undeprecatePlugin", () => {
  it("clears every deprecation column including successor_id", async () => {
    await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      note: "old reason",
      successorId: "dep-b",
    });

    await undeprecatePlugin(env.DB, "dep-a", AUTHOR_ID);

    const row = await env.DB
      .prepare(
        `SELECT deprecated_at, deprecated_by, deprecated_reason_category,
                deprecated_reason_note, successor_id
         FROM plugins WHERE id = ?`,
      )
      .bind("dep-a")
      .first<Record<string, string | null>>();
    expect(row).toEqual({
      deprecated_at: null,
      deprecated_by: null,
      deprecated_reason_category: null,
      deprecated_reason_note: null,
      successor_id: null,
    });
  });
});

describe("unlistPlugin / relistPlugin", () => {
  it("toggles unlisted_at on and off", async () => {
    await unlistPlugin(env.DB, "dep-a", AUTHOR_ID);
    const listed = await env.DB
      .prepare("SELECT unlisted_at, unlisted_by FROM plugins WHERE id = ?")
      .bind("dep-a")
      .first<{ unlisted_at: string | null; unlisted_by: string | null }>();
    expect(listed?.unlisted_at).not.toBeNull();
    expect(listed?.unlisted_by).toBe(AUTHOR_ID);

    await relistPlugin(env.DB, "dep-a");
    const relisted = await env.DB
      .prepare("SELECT unlisted_at, unlisted_by FROM plugins WHERE id = ?")
      .bind("dep-a")
      .first<{ unlisted_at: string | null; unlisted_by: string | null }>();
    expect(relisted?.unlisted_at).toBeNull();
    expect(relisted?.unlisted_by).toBeNull();
  });
});

describe("searchSuccessorCandidates", () => {
  it("excludes self, deprecated, and unlisted; caps at default limit 10", async () => {
    // Deprecate dep-b; unlist dep-c. Both should be excluded.
    await deprecatePlugin(env.DB, {
      pluginId: "dep-b",
      actorAuthorId: AUTHOR_ID,
      category: "abandoned",
    });
    await unlistPlugin(env.DB, "dep-c", AUTHOR_ID);

    const results = await searchSuccessorCandidates(
      env.DB,
      "Plugin",
      "dep-a",
    );
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("dep-a"); // self
    expect(ids).not.toContain("dep-b"); // deprecated
    expect(ids).not.toContain("dep-c"); // unlisted
    expect(ids).toContain("dep-d");
    expect(ids).toContain("dep-e");
    expect(results.length).toBeLessThanOrEqual(10);
  });
});

describe("getDeprecationWarning", () => {
  it("returns null for an active plugin", async () => {
    const w = await getDeprecationWarning(env.DB, "dep-a");
    expect(w).toBeNull();
  });

  it("returns the wire object including successor when deprecated with a successor", async () => {
    await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      note: "Superseded by Plugin B",
      successorId: "dep-b",
    });

    const w = await getDeprecationWarning(env.DB, "dep-a");
    expect(w).not.toBeNull();
    expect(w?.category).toBe("replaced");
    expect(w?.reason).toBe("Superseded by Plugin B");
    expect(w?.successor).toEqual({
      id: "dep-b",
      name: "Plugin B",
      url: "/plugins/dep-b",
    });
  });

  it("falls back to a category label when note is null", async () => {
    await deprecatePlugin(env.DB, {
      pluginId: "dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "security",
    });

    const w = await getDeprecationWarning(env.DB, "dep-a");
    expect(w?.reason).toBe("withdrawn for security reasons");
    expect(w?.category).toBe("security");
    expect(w?.successor).toBeUndefined();
  });
});
