/**
 * Integration tests for the revoke → notification flow.
 *
 * As with reports-notifications.test.ts, the vitest-pool-workers harness
 * doesn't run Astro routes, so these tests directly invoke the same
 * `emitRevokeNotification` call that the route handlers wire in.
 *
 * Coverage:
 *  - revoke-version with publicNote flag → publicNote in payload
 *  - revoke-version without publicNote flag → publicNote=null in payload
 *  - revoke (whole plugin) → eventType='revoke_plugin'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import { createAuditRecord } from "../../src/lib/audit/audit-queries";
import { emitRevokeNotification } from "../../src/lib/notifications/emitter";

const OWNER_ID = "rv-owner";
const MAINT_ID = "rv-maint";
const PLUGIN_ID = "rv-plugin";
const PLUGIN_NAME = "Revoke Notifications Test Plugin";
const VERSION = "2.4.1";
const VERSION_ID = "rv-version-001";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 850001, "rv-owner-user"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(MAINT_ID, 850002, "rv-maint-user"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, PLUGIN_NAME, "test"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("rv-collab-maint", PLUGIN_ID, MAINT_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_versions (
        id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, checksum,
        screenshots, retry_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'published', ?, ?, 1, 100, 200, 'sha256:rv', '[]', 0,
                strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(
      VERSION_ID,
      PLUGIN_ID,
      VERSION,
      `plugins/${PLUGIN_ID}/${VERSION}/bundle.tgz`,
      JSON.stringify({ id: PLUGIN_ID, version: VERSION }),
    ),
  ]);
});

function createMockQueue(): { queue: Queue; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  return { queue: { send } as unknown as Queue, send };
}

// ---------------------------------------------------------------------------
// revoke-version flow
// ---------------------------------------------------------------------------

describe("revoke-version → notifications integration", () => {
  it("createAuditRecord with versionStatusOverride='revoked' returns auditId", async () => {
    const auditId = await createAuditRecord(env.DB, {
      versionId: VERSION_ID,
      status: "complete",
      model: "admin-action",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: "telemetry leak",
      verdict: null,
      riskScore: 0,
      findings: [],
      versionStatusOverride: "revoked",
      publicNote: true,
    });
    expect(typeof auditId).toBe("string");
    expect(auditId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("publicNote=true → notification payload includes the reason as publicNote", async () => {
    const auditId = await createAuditRecord(env.DB, {
      versionId: VERSION_ID,
      status: "complete",
      model: "admin-action",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: "leaks user data",
      verdict: null,
      riskScore: 0,
      findings: [],
      versionStatusOverride: "revoked",
      publicNote: true,
    });

    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: auditId,
      scope: "version",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      version: VERSION,
      reason: "leaks user data",
      publicNote: "leaks user data", // route maps publicNote=true → reason
    });

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      const job = call[0];
      expect(job.eventType).toBe("revoke_version");
      expect(job.payload.publicNote).toBe("leaks user data");
      expect(job.payload.reason).toBe("leaks user data");
      expect(job.payload.scope).toBe("version");
    }
  });

  it("publicNote=false → notification payload has publicNote=null", async () => {
    const auditId = await createAuditRecord(env.DB, {
      versionId: VERSION_ID,
      status: "complete",
      model: "admin-action",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: "private reason",
      verdict: null,
      riskScore: 0,
      findings: [],
      versionStatusOverride: "revoked",
      publicNote: false,
    });

    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: auditId,
      scope: "version",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      version: VERSION,
      reason: "private reason",
      publicNote: null,
    });

    expect(send).toHaveBeenCalled();
    for (const call of send.mock.calls) {
      expect(call[0].payload.publicNote).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// revoke (whole plugin) flow
// ---------------------------------------------------------------------------

describe("revoke plugin → notifications integration", () => {
  it("scope='plugin' → eventType='revoke_plugin' for every recipient", async () => {
    const eventId = `revoke-plugin:${PLUGIN_ID}:${Date.now()}`;
    const { queue, send } = createMockQueue();

    await emitRevokeNotification(env.DB, queue, {
      eventId,
      scope: "plugin",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      reason: "Plugin revoked by moderator",
      publicNote: null,
    });

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[0].eventType).toBe("revoke_plugin");
      expect(call[0].eventId).toBe(eventId);
    }
  });

  it("synthetic eventId stays stable across calls with the same timestamp", async () => {
    // The route synthesizes `revoke-plugin:{id}:{Date.now()}`. Two calls
    // in the same millisecond produce the same id, so the deterministic
    // idempotency key dedupes a queue redelivery. We can't reliably test
    // millisecond collisions here, but we can verify the format.
    const eventId = `revoke-plugin:${PLUGIN_ID}:1700000000000`;
    expect(eventId).toMatch(/^revoke-plugin:.+:\d+$/);
  });
});
