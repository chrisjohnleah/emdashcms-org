import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  emitAuditNotification,
  emitReportNotification,
  emitRevokeNotification,
} from "../../../src/lib/notifications/emitter";

// ---------------------------------------------------------------------------
// Seed: a plugin owned by OWNER with a maintainer + contributor collaborator,
// and an analogous theme. Plus a no-collaborator plugin to test the empty
// fan-out branch.
// ---------------------------------------------------------------------------

const OWNER_ID = "em-owner";
const MAINTAINER_ID = "em-maint";
const CONTRIBUTOR_ID = "em-contrib";
const PLUGIN_ID = "em-plugin";
const PLUGIN_NAME = "Emitter Test Plugin";
const THEME_ID = "em-theme";
const ORPHAN_PLUGIN_ID = "em-plugin-orphan";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 820001, "em-owner-user"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(MAINTAINER_ID, 820002, "em-maintainer-user"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(CONTRIBUTOR_ID, 820003, "em-contributor-user"),

    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, PLUGIN_NAME, "Plugin used in emitter tests"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, OWNER_ID, "Emitter Test Theme", "Theme used in emitter tests"),

    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("em-collab-maint-plugin", PLUGIN_ID, MAINTAINER_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("em-collab-contrib-plugin", PLUGIN_ID, CONTRIBUTOR_ID),

    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("em-collab-maint-theme", THEME_ID, MAINTAINER_ID),

    // Orphan plugin: no rows in plugin_collaborators and no entity row at all,
    // so resolveRecipients returns [].
  ]);

  // Reset the spam-cap window so each test run starts clean (otherwise the
  // previous test pollutes the second emit and we'd get false negatives).
  await env.DB.prepare(
    "UPDATE plugins SET last_report_notification_at = NULL WHERE id = ?",
  )
    .bind(PLUGIN_ID)
    .run();
  await env.DB.prepare(
    "UPDATE themes SET last_report_notification_at = NULL WHERE id = ?",
  )
    .bind(THEME_ID)
    .run();
});

// ---------------------------------------------------------------------------
// Mock Queue helper
// ---------------------------------------------------------------------------

function createMockQueue(): {
  queue: Queue;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(undefined);
  const queue = { send } as unknown as Queue;
  return { queue, send };
}

// ---------------------------------------------------------------------------
// emitAuditNotification
// ---------------------------------------------------------------------------

describe("emitAuditNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues one job per fan-out recipient (owner + maintainer)", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-1",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: "fail",
      riskScore: 70,
      findingCount: 3,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses eventType='audit_fail' when verdict is 'fail'", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-2",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: "fail",
      riskScore: 80,
      findingCount: 1,
    });
    const calls = send.mock.calls;
    for (const call of calls) {
      expect(call[0].eventType).toBe("audit_fail");
    }
  });

  it("uses eventType='audit_warn' when verdict is 'warn'", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-3",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: "warn",
      riskScore: 30,
      findingCount: 2,
    });
    expect(send.mock.calls[0][0].eventType).toBe("audit_warn");
  });

  it("uses eventType='audit_pass' when verdict is 'pass'", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-4",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: "pass",
      riskScore: 5,
      findingCount: 0,
    });
    expect(send.mock.calls[0][0].eventType).toBe("audit_pass");
  });

  it("uses eventType='audit_error' when verdict is null", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-5",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: null,
      riskScore: 0,
      findingCount: 0,
      errorMessage: "AI inference timed out",
    });
    expect(send.mock.calls[0][0].eventType).toBe("audit_error");
  });

  it("derives a deterministic idempotency key in the payload", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-6",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: "fail",
      riskScore: 70,
      findingCount: 3,
    });
    const job = send.mock.calls[0][0];
    expect(typeof job.payload.idempotencyKey).toBe("string");
    expect(job.payload.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(job.eventId).toBe("audit-em-6");
  });

  it("does not throw when fan-out returns empty (orphan plugin)", async () => {
    const { queue, send } = createMockQueue();
    await expect(
      emitAuditNotification(env.DB, queue, {
        auditId: "audit-em-7",
        pluginId: ORPHAN_PLUGIN_ID,
        pluginName: "ghost",
        version: "1.0.0",
        verdict: "pass",
        riskScore: 0,
        findingCount: 0,
      }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not throw when enqueueNotificationJob throws — logs and continues", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue down"));
    const queue = { send } as unknown as Queue;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      emitAuditNotification(env.DB, queue, {
        auditId: "audit-em-8",
        pluginId: PLUGIN_ID,
        pluginName: PLUGIN_NAME,
        version: "1.0.0",
        verdict: "fail",
        riskScore: 70,
        findingCount: 3,
      }),
    ).resolves.toBeUndefined();
    // Both recipients attempted; both failed
    expect(send).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("excludes contributors from the recipient list", async () => {
    const { queue, send } = createMockQueue();
    await emitAuditNotification(env.DB, queue, {
      auditId: "audit-em-9",
      pluginId: PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      version: "1.0.0",
      verdict: "fail",
      riskScore: 70,
      findingCount: 3,
    });
    const recipientIds = send.mock.calls.map(
      (c) => c[0].recipientAuthorId,
    );
    expect(recipientIds).not.toContain(CONTRIBUTOR_ID);
    expect(recipientIds).toContain(OWNER_ID);
    expect(recipientIds).toContain(MAINTAINER_ID);
  });
});

// ---------------------------------------------------------------------------
// emitReportNotification
// ---------------------------------------------------------------------------

describe("emitReportNotification", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset spam-cap window
    await env.DB.prepare(
      "UPDATE plugins SET last_report_notification_at = NULL WHERE id = ?",
    )
      .bind(PLUGIN_ID)
      .run();
    await env.DB.prepare(
      "UPDATE themes SET last_report_notification_at = NULL WHERE id = ?",
    )
      .bind(THEME_ID)
      .run();
  });

  it("enqueues report_filed job for each recipient when cap allows", async () => {
    const { queue, send } = createMockQueue();
    await emitReportNotification(env.DB, queue, {
      reportId: "report-em-1",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "security",
      descriptionExcerpt: "Suspicious request to attacker.example",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].eventType).toBe("report_filed");
  });

  it("returns early (no enqueue) when 24h spam cap suppresses", async () => {
    const { queue: queue1, send: send1 } = createMockQueue();
    await emitReportNotification(env.DB, queue1, {
      reportId: "report-em-2a",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "security",
      descriptionExcerpt: "first",
    });
    expect(send1).toHaveBeenCalled();

    const { queue: queue2, send: send2 } = createMockQueue();
    await emitReportNotification(env.DB, queue2, {
      reportId: "report-em-2b",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "security",
      descriptionExcerpt: "second within 24h",
    });
    expect(send2).not.toHaveBeenCalled();
  });

  it("payload omits any reporter-identifying field", async () => {
    const { queue, send } = createMockQueue();
    await emitReportNotification(env.DB, queue, {
      reportId: "report-em-3",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "abuse",
      descriptionExcerpt: "abuse claim",
    });
    const job = send.mock.calls[0][0];
    expect(job.payload).not.toHaveProperty("reporterAuthorId");
    expect(job.payload).not.toHaveProperty("reporterUsername");
    expect(job.payload).not.toHaveProperty("reporter_author_id");
  });

  it("works for themes via the theme spam-cap path", async () => {
    const { queue, send } = createMockQueue();
    await emitReportNotification(env.DB, queue, {
      reportId: "report-em-4",
      entityType: "theme",
      entityId: THEME_ID,
      entityName: "Emitter Test Theme",
      category: "license",
      descriptionExcerpt: "license violation",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].entityType).toBe("theme");
  });

  it("does not throw when fan-out fails", async () => {
    const { queue, send } = createMockQueue();
    // Use a non-existent entity id; spam-cap will return false (no row), so
    // we won't even reach fan-out. Confirm the early return path is graceful.
    await expect(
      emitReportNotification(env.DB, queue, {
        reportId: "report-em-5",
        entityType: "plugin",
        entityId: "nonexistent-plugin",
        entityName: "ghost",
        category: "other",
        descriptionExcerpt: "noop",
      }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// emitRevokeNotification
// ---------------------------------------------------------------------------

describe("emitRevokeNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses eventType='revoke_version' when scope is 'version'", async () => {
    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: "audit-rv-1",
      scope: "version",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      version: "1.2.3",
      reason: "Contains malicious telemetry call",
      publicNote: "Contains malicious telemetry call",
    });
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[0].eventType).toBe("revoke_version");
    }
  });

  it("uses eventType='revoke_plugin' when scope is 'plugin'", async () => {
    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: "revoke-plugin:test:123",
      scope: "plugin",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      reason: "Plugin revoked by moderator",
      publicNote: null,
    });
    for (const call of send.mock.calls) {
      expect(call[0].eventType).toBe("revoke_plugin");
    }
  });

  it("includes publicNote in payload when set", async () => {
    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: "audit-rv-3",
      scope: "version",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      version: "1.2.4",
      reason: "telemetry",
      publicNote: "telemetry",
    });
    const job = send.mock.calls[0][0];
    expect(job.payload.publicNote).toBe("telemetry");
  });

  it("includes publicNote=null in payload when not set", async () => {
    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: "audit-rv-4",
      scope: "version",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      version: "1.2.5",
      reason: "private reason",
      publicNote: null,
    });
    const job = send.mock.calls[0][0];
    expect(job.payload.publicNote).toBeNull();
  });

  it("derives idempotency key from eventId + recipientAuthorId", async () => {
    const { queue, send } = createMockQueue();
    await emitRevokeNotification(env.DB, queue, {
      eventId: "audit-rv-5",
      scope: "version",
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      version: "1.0.0",
      reason: "x",
      publicNote: null,
    });
    const job0 = send.mock.calls[0][0];
    const job1 = send.mock.calls[1][0];
    expect(job0.payload.idempotencyKey).not.toBe(job1.payload.idempotencyKey);
    expect(job0.payload.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
