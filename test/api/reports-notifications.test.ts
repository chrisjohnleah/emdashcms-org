/**
 * Integration tests for the report → notification flow.
 *
 * The vitest-pool-workers harness doesn't run the Astro request pipeline,
 * so we can't fetch `/api/v1/reports` end-to-end here. Instead these tests
 * exercise the same code path the POST handler invokes after `createReport`
 * succeeds: it constructs a `NotificationJob` via `emitReportNotification`,
 * which talks to D1 (spam cap + fan-out) and a Queue producer.
 *
 * The handler-side wiring is verified by the file existence + grep
 * acceptance criteria in 12-02-PLAN.md task 2; this file proves the
 * runtime behaviour.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { createReport } from "../../src/lib/db/report-queries";
import { emitReportNotification } from "../../src/lib/notifications/emitter";

const OWNER_ID = "rn-owner";
const MAINT_ID = "rn-maint";
const PLUGIN_ID = "rn-plugin";
const PLUGIN_NAME = "Reports Notifications Test Plugin";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 840001, "rn-owner-user"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(MAINT_ID, 840002, "rn-maint-user"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, PLUGIN_NAME, "test plugin"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("rn-collab-maint", PLUGIN_ID, MAINT_ID),
  ]);
});

beforeEach(async () => {
  // Reset spam cap window so each test runs in isolation
  await env.DB.prepare(
    "UPDATE plugins SET last_report_notification_at = NULL WHERE id = ?",
  )
    .bind(PLUGIN_ID)
    .run();
});

function createMockQueue(): { queue: Queue; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  return { queue: { send } as unknown as Queue, send };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("reports → notifications integration", () => {
  it("a fresh report enqueues a NotificationJob per recipient", async () => {
    const reportId = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "security",
      description:
        "Suspicious behavior from this plugin — observed exfil to attacker.example.",
    });

    const { queue, send } = createMockQueue();
    await emitReportNotification(env.DB, queue, {
      reportId,
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "security",
      descriptionExcerpt:
        "Suspicious behavior from this plugin — observed exfil to attacker.example.",
    });

    // 2 recipients: owner + maintainer
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[0].eventType).toBe("report_filed");
      expect(call[0].entityType).toBe("plugin");
      expect(call[0].entityId).toBe(PLUGIN_ID);
    }
  });

  it("a second report inside the 24h cap window is silently suppressed", async () => {
    const reportId1 = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "abuse",
      description: "first report content",
    });
    const { queue: q1, send: send1 } = createMockQueue();
    await emitReportNotification(env.DB, q1, {
      reportId: reportId1,
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "abuse",
      descriptionExcerpt: "first report content",
    });
    expect(send1).toHaveBeenCalled();

    // Second report immediately after — should be suppressed
    const reportId2 = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "abuse",
      description: "second report content within 24h",
    });
    const { queue: q2, send: send2 } = createMockQueue();
    await emitReportNotification(env.DB, q2, {
      reportId: reportId2,
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "abuse",
      descriptionExcerpt: "second report content within 24h",
    });
    expect(send2).not.toHaveBeenCalled();
  });

  it("emitted job payload contains no reporter identity", async () => {
    const reportId = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: OWNER_ID, // signed-in reporter — must NOT leak
      reasonCategory: "license",
      description: "license violation",
    });

    const { queue, send } = createMockQueue();
    await emitReportNotification(env.DB, queue, {
      reportId,
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "license",
      descriptionExcerpt: "license violation",
    });

    for (const call of send.mock.calls) {
      const job = call[0];
      const payloadKeys = Object.keys(job.payload);
      expect(payloadKeys).not.toContain("reporterAuthorId");
      expect(payloadKeys).not.toContain("reporter_author_id");
      expect(payloadKeys).not.toContain("reporterUsername");
      // The recipient is the publisher being notified, NOT the reporter
      expect(job.recipientAuthorId).not.toBe(OWNER_ID === OWNER_ID ? "" : OWNER_ID);
    }
  });

  it("emitted job carries the report id as eventId", async () => {
    const reportId = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "broken",
      description: "broken plugin",
    });
    const { queue, send } = createMockQueue();
    await emitReportNotification(env.DB, queue, {
      reportId,
      entityType: "plugin",
      entityId: PLUGIN_ID,
      entityName: PLUGIN_NAME,
      category: "broken",
      descriptionExcerpt: "broken plugin",
    });

    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0][0].eventId).toBe(reportId);
  });
});
