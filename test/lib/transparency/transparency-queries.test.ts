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
  listWeeks,
} from "../../../src/lib/transparency/transparency-queries";
import { seedTransparencyFixture } from "../../fixtures/transparency-seed";

const TEST_WEEK_START = new Date(Date.UTC(2026, 3, 5, 0, 0, 0));
const TEST_ISO_WEEK = "2026-W14"; // ISO week of Sunday Apr 5 2026

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
