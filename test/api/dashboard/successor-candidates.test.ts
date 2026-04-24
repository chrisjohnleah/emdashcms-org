import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { GET } from "../../../src/pages/api/v1/dashboard/plugins/[id]/successor-candidates";
import {
  deprecatePlugin,
  unlistPlugin,
} from "../../../src/lib/publishing/deprecation-queries";

// ---------------------------------------------------------------------------
// Seed: three authors, one target plugin, four successor candidates with a
// mix of active / deprecated / unlisted state to exercise the scope filter.
// ---------------------------------------------------------------------------

const OWNER_ID = "sc-alice";
const MAINTAINER_ID = "sc-bob";
const CONTRIBUTOR_ID = "sc-carol";
const STRANGER_ID = "sc-dan";
const TARGET_ID = "sc-target";
const CAND_A = "sc-cand-a"; // active, installs 100
const CAND_B = "sc-cand-b"; // active, installs 50
const CAND_C = "sc-cand-c"; // deprecated → excluded
const CAND_D = "sc-cand-d"; // unlisted → excluded

async function seedAuthor(id: string, gh: number, username: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO authors (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(id, gh, username)
    .run();
}

async function seedPlugin(id: string, authorId: string, name: string, installs = 0) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugins
       (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', '[]', ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(id, authorId, name, `${name} desc`, installs)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugin_versions
       (id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, checksum,
        screenshots, retry_count, source, created_at, updated_at)
     VALUES (?, ?, '1.0.0', 'published', ?, '{}',
             1, 100, 500, 'sc-sum',
             '[]', 0, 'upload',
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(`ver-sc-${id}`, id, `bundles/${id}/1.0.0.tar.gz`)
    .run();
}

async function addCollaborator(pluginId: string, authorId: string, role: "maintainer" | "contributor") {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(`collab-sc-${pluginId}-${authorId}`, pluginId, authorId, role)
    .run();
}

beforeAll(async () => {
  await seedAuthor(OWNER_ID, 900301, "sc-alice");
  await seedAuthor(MAINTAINER_ID, 900302, "sc-bob");
  await seedAuthor(CONTRIBUTOR_ID, 900303, "sc-carol");
  await seedAuthor(STRANGER_ID, 900304, "sc-dan");

  await seedPlugin(TARGET_ID, OWNER_ID, "SC Target");
  await seedPlugin(CAND_A, OWNER_ID, "SC Candidate Alpha", 100);
  await seedPlugin(CAND_B, OWNER_ID, "SC Candidate Beta", 50);
  await seedPlugin(CAND_C, OWNER_ID, "SC Candidate Deprecated", 10);
  await seedPlugin(CAND_D, OWNER_ID, "SC Candidate Unlisted", 10);

  await addCollaborator(TARGET_ID, MAINTAINER_ID, "maintainer");
  await addCollaborator(TARGET_ID, CONTRIBUTOR_ID, "contributor");

  const r1 = await deprecatePlugin(env.DB, {
    pluginId: CAND_C,
    actorAuthorId: OWNER_ID,
    category: "unmaintained",
  });
  expect(r1).toEqual({ ok: true });
  await unlistPlugin(env.DB, CAND_D, OWNER_ID);
});

interface HandlerContext {
  params: Record<string, string>;
  request: Request;
  locals: { author?: { id: string; githubId: number; username: string } };
}

function invoke(
  pluginId: string,
  q: string | null,
  author: { id: string; githubId: number; username: string } | null,
): Promise<Response> {
  const url = new URL(`https://example.org/api/v1/dashboard/plugins/${pluginId}/successor-candidates`);
  if (q !== null) url.searchParams.set("q", q);
  const ctx: HandlerContext = {
    params: { id: pluginId },
    request: new Request(url.toString(), { method: "GET" }),
    locals: author ? { author } : {},
  };
  return (GET as unknown as (c: HandlerContext) => Promise<Response>)(ctx);
}

const OWNER_AUTHOR = { id: OWNER_ID, githubId: 900301, username: "sc-alice" };
const MAINTAINER_AUTHOR = { id: MAINTAINER_ID, githubId: 900302, username: "sc-bob" };
const CONTRIBUTOR_AUTHOR = { id: CONTRIBUTOR_ID, githubId: 900303, username: "sc-carol" };
const STRANGER_AUTHOR = { id: STRANGER_ID, githubId: 900304, username: "sc-dan" };

describe("GET /api/v1/dashboard/plugins/:id/successor-candidates", () => {
  it("returns 401 when no session author is present", async () => {
    const res = await invoke(TARGET_ID, "", null);
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is authenticated but has contributor (not maintainer+) access", async () => {
    const res = await invoke(TARGET_ID, "", CONTRIBUTOR_AUTHOR);
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller has no role on the plugin", async () => {
    const res = await invoke(TARGET_ID, "", STRANGER_AUTHOR);
    expect(res.status).toBe(403);
  });

  it("returns 200 with an empty array when the query matches nothing", async () => {
    const res = await invoke(TARGET_ID, "zzzz-no-such-plugin", OWNER_AUTHOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });

  it("excludes self, deprecated and unlisted plugins; orders by installs_count DESC; works for maintainer role", async () => {
    const res = await invoke(TARGET_ID, "SC Candidate", MAINTAINER_AUTHOR);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      candidates: Array<{ id: string; name: string; authorUsername: string }>;
    };
    const ids = body.candidates.map((c) => c.id);
    expect(ids).toContain(CAND_A);
    expect(ids).toContain(CAND_B);
    expect(ids).not.toContain(CAND_C); // deprecated
    expect(ids).not.toContain(CAND_D); // unlisted
    expect(ids).not.toContain(TARGET_ID); // self
    expect(ids.indexOf(CAND_A)).toBeLessThan(ids.indexOf(CAND_B));
  });

  it("rejects q longer than 80 characters with a 400", async () => {
    const res = await invoke(TARGET_ID, "a".repeat(81), OWNER_AUTHOR);
    expect(res.status).toBe(400);
  });
});
