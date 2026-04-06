import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  createReport,
  listReports,
  getReport,
  countReportsByStatus,
  updateReportStatus,
  banAuthor,
  unbanAuthor,
} from "../../src/lib/db/report-queries";
import { isAuthorBanned } from "../../src/lib/auth/github";

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const AUTHOR_ID = "reports-test-author-1";
const ADMIN_ID = "reports-test-admin-1";
const PLUGIN_ID = "reports-test-plugin";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reports"),
    env.DB.prepare("DELETE FROM plugins WHERE id = ?").bind(PLUGIN_ID),
    env.DB.prepare("DELETE FROM authors WHERE id IN (?, ?)").bind(
      AUTHOR_ID,
      ADMIN_ID,
    ),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at)
       VALUES (?, 90001, 'reports-author', null, 0,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(AUTHOR_ID),
    env.DB.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at)
       VALUES (?, 90002, 'reports-admin', null, 1,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(ADMIN_ID),
    env.DB.prepare(
      `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, license, installs_count, created_at, updated_at)
       VALUES (?, ?, 'Reports Test Plugin', 'Used in reports test', '[]', '[]', 'MIT', 0,
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, AUTHOR_ID),
  ]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM reports").run();
  // Reset ban state on the test author
  await env.DB.prepare(
    "UPDATE authors SET banned = 0, banned_reason = NULL, banned_at = NULL WHERE id = ?",
  )
    .bind(AUTHOR_ID)
    .run();
});

// ---------------------------------------------------------------------------
// createReport + listReports
// ---------------------------------------------------------------------------

describe("report-queries", () => {
  it("creates an authenticated report and lists it", async () => {
    const id = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: AUTHOR_ID,
      reasonCategory: "security",
      description: "Observed a network call to an undeclared host",
    });
    expect(id).toBeTruthy();

    const all = await listReports(env.DB);
    expect(all).toHaveLength(1);
    expect(all[0].entityType).toBe("plugin");
    expect(all[0].entityId).toBe(PLUGIN_ID);
    expect(all[0].reporterAuthorId).toBe(AUTHOR_ID);
    expect(all[0].reporterUsername).toBe("reports-author");
    expect(all[0].reasonCategory).toBe("security");
    expect(all[0].status).toBe("open");
  });

  it("creates an anonymous report with null reporter", async () => {
    await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "broken",
      description: "Does not work at all",
    });
    const all = await listReports(env.DB);
    expect(all).toHaveLength(1);
    expect(all[0].reporterAuthorId).toBeNull();
    expect(all[0].reporterUsername).toBeNull();
  });

  it("filters listReports by status", async () => {
    await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "abuse",
      description: "Contains deceptive marketing",
    });
    const id2 = await createReport(env.DB, {
      entityType: "plugin",
      entityId: PLUGIN_ID,
      reporterAuthorId: null,
      reasonCategory: "other",
      description: "Filed as a test filler",
    });
    await updateReportStatus(env.DB, id2, "resolved", "test resolution", ADMIN_ID);

    const openReports = await listReports(env.DB, "open");
    expect(openReports).toHaveLength(1);
    expect(openReports[0].reasonCategory).toBe("abuse");

    const resolved = await listReports(env.DB, "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolutionNote).toBe("test resolution");
    expect(resolved[0].resolvedByAuthorId).toBe(ADMIN_ID);
    expect(resolved[0].resolvedAt).not.toBeNull();
  });

  it("counts reports by status", async () => {
    const ids = await Promise.all([
      createReport(env.DB, {
        entityType: "plugin",
        entityId: PLUGIN_ID,
        reporterAuthorId: null,
        reasonCategory: "broken",
        description: "One broken report",
      }),
      createReport(env.DB, {
        entityType: "plugin",
        entityId: PLUGIN_ID,
        reporterAuthorId: null,
        reasonCategory: "security",
        description: "One security report",
      }),
    ]);
    await updateReportStatus(env.DB, ids[0], "dismissed", null, ADMIN_ID);

    const counts = await countReportsByStatus(env.DB);
    expect(counts.open).toBe(1);
    expect(counts.dismissed).toBe(1);
    expect(counts.resolved).toBe(0);
    expect(counts.investigating).toBe(0);
  });

  it("getReport returns null for unknown id", async () => {
    const report = await getReport(env.DB, "does-not-exist");
    expect(report).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ban / unban
// ---------------------------------------------------------------------------

describe("author bans", () => {
  it("banAuthor sets banned=1 and isAuthorBanned reflects it", async () => {
    const before = await isAuthorBanned(env.DB, AUTHOR_ID);
    expect(before.banned).toBe(false);

    const banned = await banAuthor(env.DB, AUTHOR_ID, "Caught using eval in plugin");
    expect(banned).toBe(true);

    const after = await isAuthorBanned(env.DB, AUTHOR_ID);
    expect(after.banned).toBe(true);
    expect(after.reason).toBe("Caught using eval in plugin");
  });

  it("unbanAuthor clears the ban", async () => {
    await banAuthor(env.DB, AUTHOR_ID, "Temporary ban for testing");
    const unbanned = await unbanAuthor(env.DB, AUTHOR_ID);
    expect(unbanned).toBe(true);

    const after = await isAuthorBanned(env.DB, AUTHOR_ID);
    expect(after.banned).toBe(false);
    expect(after.reason).toBeNull();
  });

  it("isAuthorBanned returns {false, null} for unknown author id", async () => {
    const result = await isAuthorBanned(env.DB, "does-not-exist");
    expect(result.banned).toBe(false);
    expect(result.reason).toBeNull();
  });
});
