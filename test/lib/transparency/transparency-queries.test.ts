/**
 * Phase 15 — transparency_queries integration tests.
 *
 * --------------------------------------------------------------------
 * Format audit (Task 1, recorded against local D1 emdashcms-org seed):
 *
 *   plugin_versions.created_at:  ISO `YYYY-MM-DDTHH:MM:SSZ` (e.g. 2026-01-15T10:00:00Z)
 *   plugin_audits.created_at:    ISO `YYYY-MM-DDTHH:MM:SSZ` (e.g. 2026-01-15T11:00:00Z)
 *   reports.created_at:          declared `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` in
 *                                migration 0015 → ISO `T...Z` format. Seed empty in
 *                                dev DB so audit returned `[]`; format is enforced
 *                                by the migration default and matches the others.
 *   reports.resolved_at:         nullable; when written by the moderator path is
 *                                ISO `T...Z` format (mirrors created_at).
 *   audit_budget.date:           `YYYY-MM-DD` (10-char date only) — migration 0004
 *                                declares it as a TEXT primary key sliced to the
 *                                day; aggregation queries MUST bind YYYY-MM-DD
 *                                slices, NOT full ISO timestamps.
 *
 * Conclusion: every per-row `created_at` and `resolved_at` is ISO `T...Z`, so
 * window bounds bind directly via `Date.toISOString()`. `audit_budget.date`
 * needs the `.slice(0,10)` bound. No per-table format conversion required.
 * --------------------------------------------------------------------
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  computeWeeklySnapshot,
  upsertTransparencyWeek,
  getLatestWeek,
  getWeekByIsoWeek,
  getLifecycleMetricsStartWeek,
  listWeeks,
} from "../../../src/lib/transparency/transparency-queries";
import { seedTransparencyFixture } from "../../fixtures/transparency-seed";

const TEST_WEEK_START = new Date(Date.UTC(2026, 3, 5, 0, 0, 0));
const TEST_ISO_WEEK = "2026-W14"; // ISO week of Sunday Apr 5 2026
const TEST_WEEK_END = new Date(Date.UTC(2026, 3, 12, 0, 0, 0));

// Plugin ids from the shared transparency-seed fixture.
const PLUGIN_A = "plugin-id-TEST-f3a9c1";
const PLUGIN_B = "plugin-id-TEST-9k2bcd";

async function clearTables() {
  await env.DB.exec(
    "DELETE FROM transparency_weeks; DELETE FROM plugin_audits; DELETE FROM plugin_versions; DELETE FROM reports; DELETE FROM audit_budget; DELETE FROM plugins; DELETE FROM authors;",
  );
}

describe("computeWeeklySnapshot", () => {
  beforeEach(async () => {
    await clearTables();
    await seedTransparencyFixture(env.DB, { weekStart: TEST_WEEK_START });
  });

  it("counts versions submitted in the window", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.versions_submitted).toBe(3);
  });

  it("counts published / rejected / revoked / flagged audit completions", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.versions_published).toBe(1);
    expect(snapshot.versions_rejected).toBe(1);
    expect(snapshot.versions_revoked).toBe(1); // model='admin-action' row
    expect(snapshot.versions_flagged).toBe(0);
  });

  it("counts reports filed by category", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.reports_filed_security).toBe(1);
    expect(snapshot.reports_filed_abuse).toBe(1);
    expect(snapshot.reports_filed_broken).toBe(1);
    expect(snapshot.reports_filed_license).toBe(0);
    expect(snapshot.reports_filed_other).toBe(0);
  });

  it("counts reports resolved and dismissed in the window", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.reports_resolved).toBe(1);
    expect(snapshot.reports_dismissed).toBe(1);
  });

  it("sums neurons_spent from audit_budget for the window", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.neurons_spent).toBe(4242);
  });

  it("sets iso_week / week_start / week_end to the resolved bounds", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.iso_week).toBe(TEST_ISO_WEEK);
    expect(snapshot.week_start.startsWith("2026-04-05")).toBe(true);
    expect(snapshot.week_end.startsWith("2026-04-12")).toBe(true);
  });
});

describe("upsertTransparencyWeek", () => {
  beforeEach(async () => {
    await clearTables();
    await seedTransparencyFixture(env.DB, { weekStart: TEST_WEEK_START });
  });

  it("is idempotent — calling twice with the same iso_week leaves one row", async () => {
    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    await upsertTransparencyWeek(env.DB, snapshot);
    await upsertTransparencyWeek(env.DB, snapshot);
    const result = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM transparency_weeks WHERE iso_week = ?`)
      .bind(TEST_ISO_WEEK)
      .first<{ c: number }>();
    expect(result?.c).toBe(1);
  });
});

describe("getLatestWeek / getWeekByIsoWeek / listWeeks", () => {
  beforeEach(async () => {
    await clearTables();
    await seedTransparencyFixture(env.DB, { weekStart: TEST_WEEK_START });
    // Insert two transparency_weeks rows to test ordering
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO transparency_weeks (iso_week, week_start, week_end) VALUES (?, ?, ?)`,
        )
        .bind("2026-W14", "2026-04-05T00:00:00Z", "2026-04-12T00:00:00Z"),
      env.DB
        .prepare(
          `INSERT INTO transparency_weeks (iso_week, week_start, week_end) VALUES (?, ?, ?)`,
        )
        .bind("2026-W12", "2026-03-22T00:00:00Z", "2026-03-29T00:00:00Z"),
      env.DB
        .prepare(
          `INSERT INTO transparency_weeks (iso_week, week_start, week_end) VALUES (?, ?, ?)`,
        )
        .bind("2026-W13", "2026-03-29T00:00:00Z", "2026-04-05T00:00:00Z"),
    ]);
  });

  it("getLatestWeek returns the highest iso_week", async () => {
    const row = await getLatestWeek(env.DB);
    expect(row?.iso_week).toBe("2026-W14");
  });

  it("getWeekByIsoWeek returns the seeded row", async () => {
    const row = await getWeekByIsoWeek(env.DB, "2026-W13");
    expect(row?.iso_week).toBe("2026-W13");
  });

  it("getWeekByIsoWeek returns null for a missing iso_week", async () => {
    const row = await getWeekByIsoWeek(env.DB, "9999-W99");
    expect(row).toBeNull();
  });

  it("listWeeks returns rows newest-first", async () => {
    const rows = await listWeeks(env.DB);
    expect(rows.map((r) => r.iso_week)).toEqual([
      "2026-W14",
      "2026-W13",
      "2026-W12",
    ]);
  });

  it("listWeeks honours a cursor (returns weeks strictly older than the cursor)", async () => {
    const rows = await listWeeks(env.DB, "2026-W14");
    expect(rows.map((r) => r.iso_week)).toEqual(["2026-W13", "2026-W12"]);
  });
});

describe("computeWeeklySnapshot — lifecycle counters (Phase 22-01, EHAA-01)", () => {
  beforeEach(async () => {
    await clearTables();
    await seedTransparencyFixture(env.DB, { weekStart: TEST_WEEK_START });
  });

  it("counts deprecations filed inside the window (D-01)", async () => {
    // Two plugins deprecated inside the window — Mon and Wed 12:00 UTC.
    const monday = new Date(TEST_WEEK_START);
    monday.setUTCDate(monday.getUTCDate() + 1);
    monday.setUTCHours(12, 0, 0, 0);
    const wednesday = new Date(TEST_WEEK_START);
    wednesday.setUTCDate(wednesday.getUTCDate() + 3);
    wednesday.setUTCHours(12, 0, 0, 0);

    await env.DB.batch([
      env.DB
        .prepare(`UPDATE plugins SET deprecated_at = ? WHERE id = ?`)
        .bind(monday.toISOString(), PLUGIN_A),
      env.DB
        .prepare(`UPDATE plugins SET deprecated_at = ? WHERE id = ?`)
        .bind(wednesday.toISOString(), PLUGIN_B),
    ]);

    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.deprecations_count).toBe(2);
  });

  it("counts unlists filed inside the window (D-01)", async () => {
    const friday = new Date(TEST_WEEK_START);
    friday.setUTCDate(friday.getUTCDate() + 5);
    friday.setUTCHours(12, 0, 0, 0);

    await env.DB
      .prepare(`UPDATE plugins SET unlisted_at = ? WHERE id = ?`)
      .bind(friday.toISOString(), PLUGIN_A)
      .run();

    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.unlists_count).toBe(1);
  });

  it("deprecate-then-undeprecate inside same week reads as zero events (D-02 caveat)", async () => {
    // Plugin gets deprecated_at set inside window, then undeprecatePlugin
    // (in production code) clears deprecated_at = NULL. Because we count
    // event-in-window via deprecated_at, the cleared row reads as zero.
    const monday = new Date(TEST_WEEK_START);
    monday.setUTCDate(monday.getUTCDate() + 1);
    monday.setUTCHours(12, 0, 0, 0);

    await env.DB
      .prepare(`UPDATE plugins SET deprecated_at = ? WHERE id = ?`)
      .bind(monday.toISOString(), PLUGIN_A)
      .run();
    // Simulate undeprecatePlugin's NULL clear (D-02 caveat).
    await env.DB
      .prepare(`UPDATE plugins SET deprecated_at = NULL WHERE id = ?`)
      .bind(PLUGIN_A)
      .run();

    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.deprecations_count).toBe(0);
  });

  it("boundary handling: deprecation BEFORE weekStart not counted; unlist AT weekEnd not counted (D-03, half-open window)", async () => {
    // Window is `>= weekStart AND < weekEnd`.
    // PLUGIN_A: deprecated 1 millisecond before weekStart — must NOT count.
    const beforeStart = new Date(TEST_WEEK_START.getTime() - 1).toISOString();
    // PLUGIN_B: unlisted exactly AT weekEnd — must NOT count.
    const atEnd = TEST_WEEK_END.toISOString();

    await env.DB.batch([
      env.DB
        .prepare(`UPDATE plugins SET deprecated_at = ? WHERE id = ?`)
        .bind(beforeStart, PLUGIN_A),
      env.DB
        .prepare(`UPDATE plugins SET unlisted_at = ? WHERE id = ?`)
        .bind(atEnd, PLUGIN_B),
    ]);

    const snapshot = await computeWeeklySnapshot(env.DB, TEST_ISO_WEEK);
    expect(snapshot.deprecations_count).toBe(0);
    expect(snapshot.unlists_count).toBe(0);
  });
});

describe("upsertTransparencyWeek — lifecycle column round-trip (Phase 22-01, D-15)", () => {
  beforeEach(async () => {
    await clearTables();
  });

  it("round-trips non-zero deprecations_count and unlists_count (column/placeholder alignment)", async () => {
    // D-15: upsert went 16 → 18 columns. Off-by-one between the column
    // list and the .bind(...) arguments would silently shift values into
    // the wrong column. Use distinct, distinguishable values for the
    // two new counters so any drift surfaces immediately.
    await upsertTransparencyWeek(env.DB, {
      iso_week: "2026-W20",
      week_start: "2026-05-17T00:00:00Z",
      week_end: "2026-05-24T00:00:00Z",
      versions_submitted: 11,
      versions_published: 12,
      versions_flagged: 13,
      versions_rejected: 14,
      versions_revoked: 15,
      reports_filed_security: 16,
      reports_filed_abuse: 17,
      reports_filed_broken: 18,
      reports_filed_license: 19,
      reports_filed_other: 20,
      reports_resolved: 21,
      reports_dismissed: 22,
      neurons_spent: 23,
      deprecations_count: 7,
      unlists_count: 3,
    });

    const row = await getWeekByIsoWeek(env.DB, "2026-W20");
    expect(row).not.toBeNull();
    expect(row?.deprecations_count).toBe(7);
    expect(row?.unlists_count).toBe(3);
    // Sanity-check a few neighbouring columns to confirm no shift.
    expect(row?.neurons_spent).toBe(23);
    expect(row?.reports_dismissed).toBe(22);
    expect(row?.versions_submitted).toBe(11);
  });
});

describe("getLifecycleMetricsStartWeek (Phase 22-01, D-09)", () => {
  beforeEach(async () => {
    await clearTables();
  });

  it("returns the earliest iso_week with a non-zero lifecycle counter", async () => {
    // Three weeks: W10 has zero counters; W11 has unlists_count=2;
    // W12 has deprecations_count=5. Earliest non-zero row is W11.
    const baseSnapshot = {
      week_start: "2026-03-01T00:00:00Z",
      week_end: "2026-03-08T00:00:00Z",
      versions_submitted: 0,
      versions_published: 0,
      versions_flagged: 0,
      versions_rejected: 0,
      versions_revoked: 0,
      reports_filed_security: 0,
      reports_filed_abuse: 0,
      reports_filed_broken: 0,
      reports_filed_license: 0,
      reports_filed_other: 0,
      reports_resolved: 0,
      reports_dismissed: 0,
      neurons_spent: 0,
      deprecations_count: 0,
      unlists_count: 0,
    };

    await upsertTransparencyWeek(env.DB, {
      ...baseSnapshot,
      iso_week: "2026-W10",
    });
    await upsertTransparencyWeek(env.DB, {
      ...baseSnapshot,
      iso_week: "2026-W11",
      unlists_count: 2,
    });
    await upsertTransparencyWeek(env.DB, {
      ...baseSnapshot,
      iso_week: "2026-W12",
      deprecations_count: 5,
    });

    const startWeek = await getLifecycleMetricsStartWeek(env.DB);
    expect(startWeek).toBe("2026-W11");
  });

  it("returns null when every row has zero lifecycle counters (D-08 footnote omitted)", async () => {
    await upsertTransparencyWeek(env.DB, {
      iso_week: "2026-W10",
      week_start: "2026-03-01T00:00:00Z",
      week_end: "2026-03-08T00:00:00Z",
      versions_submitted: 0,
      versions_published: 0,
      versions_flagged: 0,
      versions_rejected: 0,
      versions_revoked: 0,
      reports_filed_security: 0,
      reports_filed_abuse: 0,
      reports_filed_broken: 0,
      reports_filed_license: 0,
      reports_filed_other: 0,
      reports_resolved: 0,
      reports_dismissed: 0,
      neurons_spent: 0,
      deprecations_count: 0,
      unlists_count: 0,
    });

    const startWeek = await getLifecycleMetricsStartWeek(env.DB);
    expect(startWeek).toBeNull();
  });
});
