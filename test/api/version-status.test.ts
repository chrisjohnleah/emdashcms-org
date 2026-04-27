import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { GET } from "../../src/pages/api/v1/plugins/[id]/versions/[version]/index";

const AUTHOR_ID = "vstatus-author";
const PLUGIN_ID = "vstatus-plugin";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions WHERE plugin_id = ?").bind(
      PLUGIN_ID,
    ),
    env.DB.prepare("DELETE FROM plugins WHERE id = ?").bind(PLUGIN_ID),
    env.DB.prepare("DELETE FROM authors WHERE id = ?").bind(AUTHOR_ID),
  ]);

  await env.DB.prepare(
    `INSERT INTO authors (id, github_id, github_username, created_at, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind(AUTHOR_ID, 990001, "vstatus")
    .run();

  await env.DB.prepare(
    `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
     VALUES (?, ?, 'vstatus plugin', 'desc', '[]', '[]', 0,
             strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind(PLUGIN_ID, AUTHOR_ID)
    .run();

  // Two versions: one pending (no audit yet), one published (with audit pass)
  await env.DB.prepare(
    `INSERT INTO plugin_versions
       (id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, checksum,
        screenshots, retry_count, source, created_at, updated_at)
     VALUES (?, ?, '1.0.0', 'pending', ?, '{}',
             1, 12345, 50000, 'sha-pending',
             '[]', 0, 'upload',
             strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind("vstatus-v-pending", PLUGIN_ID, `bundles/${PLUGIN_ID}/1.0.0.tar.gz`)
    .run();

  await env.DB.prepare(
    `INSERT INTO plugin_versions
       (id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, checksum,
        screenshots, retry_count, source, created_at, updated_at)
     VALUES (?, ?, '1.1.0', 'published', ?, '{}',
             1, 23456, 60000, 'sha-published',
             '[]', 0, 'upload',
             strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind("vstatus-v-published", PLUGIN_ID, `bundles/${PLUGIN_ID}/1.1.0.tar.gz`)
    .run();

  await env.DB.prepare(
    `INSERT INTO plugin_audits
       (id, plugin_version_id, status, model, verdict, risk_score, findings,
        raw_response, public_note, created_at)
     VALUES (?, ?, 'completed', 'cf/google/gemma', 'pass', 5, '[]', '{}', 0,
             strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind("vstatus-audit-1", "vstatus-v-published")
    .run();
});

function invoke(pluginId: string, version: string): Promise<Response> {
  return (
    GET as unknown as (ctx: {
      params: Record<string, string>;
    }) => Promise<Response>
  )({ params: { id: pluginId, version } });
}

describe("GET /api/v1/plugins/:id/versions/:version", () => {
  it("returns the CLI-shaped payload for a pending version (no audit yet)", async () => {
    const res = await invoke(PLUGIN_ID, "1.0.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe("1.0.0");
    expect(body.status).toBe("pending");
    expect(body.audit_verdict).toBeNull();
    expect(body.image_audit_verdict).toBeNull();
    expect(body.checksum).toBe("sha-pending");
    expect(body.bundleSize).toBe(12345);
  });

  it("includes the audit verdict for a published version", async () => {
    const res = await invoke(PLUGIN_ID, "1.1.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("published");
    expect(body.audit_verdict).toBe("pass");
    expect(body.checksum).toBe("sha-published");
    expect(body.bundleSize).toBe(23456);
  });

  it("returns 404 for an unknown version", async () => {
    const res = await invoke(PLUGIN_ID, "99.0.0");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown plugin", async () => {
    const res = await invoke("does-not-exist", "1.0.0");
    expect(res.status).toBe(404);
  });
});
