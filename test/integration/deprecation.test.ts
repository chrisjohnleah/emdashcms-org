import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  deprecatePlugin,
  undeprecatePlugin,
  unlistPlugin,
} from "../../src/lib/publishing/deprecation-queries";
import { searchPlugins } from "../../src/lib/db/queries";

/**
 * Phase 17 integration tests — deprecation end-to-end.
 *
 * Composes the 17-01 query layer under realistic multi-plugin scenarios:
 * successor-chain cycle detection (direct + deep), default-sort demotion
 * with a 100x install-count disparity, un-deprecate round-trip, and the
 * remaining successor validation edges. Unit coverage in
 * test/lib/deprecation-queries.test.ts exercises each function in
 * isolation; this file proves the pieces compose correctly.
 */

const AUTHOR_ID = "int17-dep-alice";
const AUTHOR_GITHUB_ID = 910300;

type SeedOpts = {
  id: string;
  name: string;
  installs?: number;
};

async function seedAuthor(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors
       (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(AUTHOR_ID, AUTHOR_GITHUB_ID, "int17-dep-alice")
    .run();
}

/**
 * Seed a plugin + one published version atomically via db.batch so the
 * plugin is immediately searchable. installs defaults to 0 and can be
 * overridden for sort-demotion scenarios.
 */
async function seedPlugin({ id, name, installs = 0 }: SeedOpts): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO plugins
           (id, author_id, name, description, capabilities, keywords,
            installs_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', '[]', ?,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(id, AUTHOR_ID, name, `${name} description`, installs),
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO plugin_versions
           (id, plugin_id, version, status, bundle_key, manifest,
            file_count, compressed_size, decompressed_size, checksum,
            screenshots, retry_count, source, created_at, updated_at)
         VALUES (?, ?, '1.0.0', 'published', ?, '{}',
                 1, 100, 500, 'int17-dep-checksum',
                 '[]', 0, 'upload',
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .bind(`ver-${id}`, id, `bundles/${id}/1.0.0.tar.gz`),
  ]);
}

async function wipePlugin(id: string): Promise<void> {
  // Clear FKs into plugins(id) before DELETE — successor_id on plugins
  // itself, plus every child table (plugin_versions, installs,
  // plugin_github_links, download_dedup). Prevents SQLITE_CONSTRAINT_FOREIGNKEY
  // when tests share successor chains or run after install/download paths.
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

const ALL_IDS = [
  "int17-dep-a",
  "int17-dep-b",
  "int17-dep-c",
  "int17-dep-d",
  "int17-dep-e",
  "int17-dep-x",
  "int17-dep-y",
  "int17-dep-z",
  "int17-dep-active",
  "int17-dep-dep",
];

beforeAll(async () => {
  await seedAuthor();
});

beforeEach(async () => {
  // Each test gets a clean slate so seeding with INSERT OR REPLACE can
  // freely reset installs_count without bleed between describe blocks.
  for (const id of ALL_IDS) {
    await wipePlugin(id);
  }
});

describe("Phase 17 — deprecation end-to-end", () => {
  it("detectSuccessorCycle rejects A->B->A (immediate cycle)", async () => {
    await seedPlugin({ id: "int17-dep-a", name: "Plugin A" });
    await seedPlugin({ id: "int17-dep-b", name: "Plugin B" });

    // A legitimately points at B.
    const step1 = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-a",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "int17-dep-b",
    });
    expect(step1).toEqual({ ok: true });

    // B now tries to point back at A. A is already deprecated, which
    // would trip `successor_deprecated` before the cycle check. We
    // un-deprecate A first so the cycle check is the gate we hit —
    // mirroring the real flow where publishers might flip states in
    // any order.
    await undeprecatePlugin(env.DB, "int17-dep-a", AUTHOR_ID);

    // Restore the A->B edge via a direct UPDATE so the plugin row
    // still shows A->B without A being deprecated, then attempt B->A.
    await env.DB
      .prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
      .bind("int17-dep-b", "int17-dep-a")
      .run();

    const cycleAttempt = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-b",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "int17-dep-a",
    });
    expect(cycleAttempt).toEqual({ ok: false, error: "successor_cycle" });
  });

  it("detectSuccessorCycle rejects a deep 4-node cycle D->E->A->D", async () => {
    await seedPlugin({ id: "int17-dep-a", name: "A" });
    await seedPlugin({ id: "int17-dep-d", name: "D" });
    await seedPlugin({ id: "int17-dep-e", name: "E" });

    // Seed chain E -> A and A -> D by direct UPDATE so neither is
    // deprecated (the deprecatePlugin path would mark them deprecated
    // and then successor_deprecated would fire before the cycle check).
    await env.DB.batch([
      env.DB
        .prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
        .bind("int17-dep-a", "int17-dep-e"),
      env.DB
        .prepare("UPDATE plugins SET successor_id = ? WHERE id = ?")
        .bind("int17-dep-d", "int17-dep-a"),
    ]);

    // Attempt to deprecate D pointing at E. Following E -> A -> D
    // closes the cycle on D.
    const result = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-d",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "int17-dep-e",
    });
    expect(result).toEqual({ ok: false, error: "successor_cycle" });
  });

  it("search default sort demotes deprecated plugins below active ones despite 100x install disparity", async () => {
    await seedPlugin({ id: "int17-dep-active", name: "Active", installs: 10 });
    await seedPlugin({ id: "int17-dep-dep", name: "Deprecated", installs: 1000 });

    const depResult = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-dep",
      actorAuthorId: AUTHOR_ID,
      category: "unmaintained",
    });
    expect(depResult).toEqual({ ok: true });

    const page = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 10,
    });

    const activeIdx = page.items.findIndex((p) => p.id === "int17-dep-active");
    const depIdx = page.items.findIndex((p) => p.id === "int17-dep-dep");

    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(depIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeLessThan(depIdx);

    const deprecatedPlugin = page.items[depIdx];
    expect(deprecatedPlugin.deprecated).toBe(true);
  });

  it("un-deprecate restores the default-sort position and clears the deprecated flag", async () => {
    await seedPlugin({ id: "int17-dep-active", name: "Active", installs: 10 });
    await seedPlugin({ id: "int17-dep-dep", name: "Deprecated", installs: 1000 });

    await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-dep",
      actorAuthorId: AUTHOR_ID,
      category: "unmaintained",
    });
    await undeprecatePlugin(env.DB, "int17-dep-dep", AUTHOR_ID);

    const page = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 10,
    });

    // With the flag cleared, the install-count ordering wins: 1000 > 10.
    const firstOurs = page.items.find(
      (p) => p.id === "int17-dep-dep" || p.id === "int17-dep-active",
    );
    expect(firstOurs?.id).toBe("int17-dep-dep");

    const restored = page.items.find((p) => p.id === "int17-dep-dep");
    expect(restored?.deprecated).toBe(false);
  });

  it("deprecatePlugin rejects a successor that is unlisted", async () => {
    await seedPlugin({ id: "int17-dep-x", name: "X" });
    await seedPlugin({ id: "int17-dep-y", name: "Y" });

    await unlistPlugin(env.DB, "int17-dep-y", AUTHOR_ID);

    const result = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-x",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "int17-dep-y",
    });
    expect(result).toEqual({ ok: false, error: "successor_unlisted" });
  });

  it("deprecatePlugin rejects a self-referential successor", async () => {
    await seedPlugin({ id: "int17-dep-z", name: "Z" });

    const result = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-z",
      actorAuthorId: AUTHOR_ID,
      category: "replaced",
      successorId: "int17-dep-z",
    });
    expect(result).toEqual({ ok: false, error: "successor_self" });
  });

  it("deprecatePlugin rejects a note exceeding 500 chars after trim (note_too_long)", async () => {
    await seedPlugin({ id: "int17-dep-z", name: "Z" });

    const result = await deprecatePlugin(env.DB, {
      pluginId: "int17-dep-z",
      actorAuthorId: AUTHOR_ID,
      category: "unmaintained",
      note: "x".repeat(501),
    });
    expect(result).toEqual({ ok: false, error: "note_too_long" });
  });
});
