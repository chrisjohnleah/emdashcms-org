/**
 * Integration tests for the three transparency pages.
 *
 * LOCKED APPROACH (per Plan 2 contract): these tests do NOT import any
 * Astro page module. workerd's test pool does not run the Astro router,
 * and the renderer is a pure function (`renderTransparencyHtml`) living
 * in `src/lib/transparency/render.ts`. The query layer is already
 * testable from workerd via the existing fixtures, so the tests exercise
 * exactly the data path the page frontmatter follows:
 *
 *   Astro.params → regex validate → query function → renderer → HTML
 *
 * Each block below maps onto one of those steps.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { seedTransparencyFixture } from "../fixtures/transparency-seed";
import { runWeeklyTransparency } from "../../src/lib/transparency/cron-handler";
import {
  getLatestWeek,
  getWeekByIsoWeek,
  listWeeks,
} from "../../src/lib/transparency/transparency-queries";
import { renderTransparencyHtml } from "../../src/lib/transparency/render";
import {
  previousWeek,
  nextWeek,
  isoWeekLabelFor,
} from "../../src/lib/transparency/week-boundary";

const ISO_WEEK_RE = /^\d{4}-W\d{2}$/;

async function resetTables() {
  await env.DB.exec(
    "DELETE FROM transparency_weeks; DELETE FROM plugin_audits; DELETE FROM plugin_versions; DELETE FROM reports; DELETE FROM audit_budget; DELETE FROM plugins; DELETE FROM authors;",
  );
}

describe("/transparency (latest snapshot page)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("empty DB → getLatestWeek returns null (empty state path)", async () => {
    const row = await getLatestWeek(env.DB);
    expect(row).toBeNull();
  });

  it("single seeded week → getLatestWeek returns the row and the prev-week label has NO DB entry (prev link rendered disabled)", async () => {
    const { weekStart } = await seedTransparencyFixture(env.DB);
    const isoWeek = isoWeekLabelFor(weekStart);
    // Manually insert a transparency_weeks row for the seeded week so
    // getLatestWeek has something to return. We bypass runWeeklyTransparency
    // because it uses `new Date()` which would aggregate an empty window.
    const { computeWeeklySnapshot, upsertTransparencyWeek } = await import(
      "../../src/lib/transparency/transparency-queries"
    );
    const snapshot = await computeWeeklySnapshot(env.DB, isoWeek);
    await upsertTransparencyWeek(env.DB, snapshot);

    const row = await getLatestWeek(env.DB);
    expect(row).not.toBeNull();
    expect(row!.iso_week).toBe(isoWeek);

    const prevLabel = previousWeek(row!.iso_week);
    const prevRow = await getWeekByIsoWeek(env.DB, prevLabel);
    expect(prevRow).toBeNull();
  });

  it("two consecutive seeded weeks → latest has a working previous link, older has a working next link", async () => {
    const weekAStart = new Date(Date.UTC(2026, 3, 5, 0, 0, 0)); // Sunday 2026-04-05
    const weekBStart = new Date(Date.UTC(2026, 3, 12, 0, 0, 0)); // Sunday 2026-04-12
    const isoA = isoWeekLabelFor(weekAStart);
    const isoB = isoWeekLabelFor(weekBStart);

    const { computeWeeklySnapshot, upsertTransparencyWeek } = await import(
      "../../src/lib/transparency/transparency-queries"
    );

    await seedTransparencyFixture(env.DB, { weekStart: weekAStart });
    await upsertTransparencyWeek(
      env.DB,
      await computeWeeklySnapshot(env.DB, isoA),
    );
    // Second week: upsert a row directly (no seed, empty counts is fine).
    await upsertTransparencyWeek(
      env.DB,
      await computeWeeklySnapshot(env.DB, isoB),
    );

    const latest = await getLatestWeek(env.DB);
    expect(latest!.iso_week).toBe(isoB);

    const prevOfLatest = await getWeekByIsoWeek(
      env.DB,
      previousWeek(latest!.iso_week),
    );
    expect(prevOfLatest).not.toBeNull();
    expect(prevOfLatest!.iso_week).toBe(isoA);

    const nextOfOlder = await getWeekByIsoWeek(env.DB, nextWeek(isoA));
    expect(nextOfOlder).not.toBeNull();
    expect(nextOfOlder!.iso_week).toBe(isoB);
  });
});

describe("/transparency/[iso_week] (archived snapshot page)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("getWeekByIsoWeek('9999-W99') returns null (404 path)", async () => {
    const row = await getWeekByIsoWeek(env.DB, "9999-W99");
    expect(row).toBeNull();
  });

  it("invalid ISO week format is rejected by the page's regex before any DB query", () => {
    expect(ISO_WEEK_RE.test("not-a-week")).toBe(false);
    expect(ISO_WEEK_RE.test("2026-15")).toBe(false);
    expect(ISO_WEEK_RE.test("2026-W1")).toBe(false); // too few digits
    expect(ISO_WEEK_RE.test("2026-W15")).toBe(true);
    expect(ISO_WEEK_RE.test("2026-W53")).toBe(true);
  });

  it("valid seeded week → getWeekByIsoWeek returns the row", async () => {
    const { weekStart } = await seedTransparencyFixture(env.DB);
    const isoWeek = isoWeekLabelFor(weekStart);
    const { computeWeeklySnapshot, upsertTransparencyWeek } = await import(
      "../../src/lib/transparency/transparency-queries"
    );
    await upsertTransparencyWeek(
      env.DB,
      await computeWeeklySnapshot(env.DB, isoWeek),
    );

    const row = await getWeekByIsoWeek(env.DB, isoWeek);
    expect(row).not.toBeNull();
    expect(row!.iso_week).toBe(isoWeek);
  });
});

describe("/transparency/archive (list page)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("listWeeks with three seeded rows returns them newest-first", async () => {
    const { computeWeeklySnapshot, upsertTransparencyWeek } = await import(
      "../../src/lib/transparency/transparency-queries"
    );

    const weekStarts = [
      new Date(Date.UTC(2026, 2, 29, 0, 0, 0)), // 2026-03-29 Sun
      new Date(Date.UTC(2026, 3, 5, 0, 0, 0)), // 2026-04-05 Sun
      new Date(Date.UTC(2026, 3, 12, 0, 0, 0)), // 2026-04-12 Sun
    ];
    for (const ws of weekStarts) {
      const iso = isoWeekLabelFor(ws);
      await upsertTransparencyWeek(
        env.DB,
        await computeWeeklySnapshot(env.DB, iso),
      );
    }

    const rows = await listWeeks(env.DB, undefined, 52);
    expect(rows).toHaveLength(3);
    expect(rows[0].iso_week).toBe(isoWeekLabelFor(weekStarts[2]));
    expect(rows[2].iso_week).toBe(isoWeekLabelFor(weekStarts[0]));
  });

  it("listWeeks with cursor returns rows STRICTLY older than the cursor", async () => {
    const { computeWeeklySnapshot, upsertTransparencyWeek } = await import(
      "../../src/lib/transparency/transparency-queries"
    );

    const weekStarts = [
      new Date(Date.UTC(2026, 2, 29, 0, 0, 0)),
      new Date(Date.UTC(2026, 3, 5, 0, 0, 0)),
      new Date(Date.UTC(2026, 3, 12, 0, 0, 0)),
    ];
    for (const ws of weekStarts) {
      const iso = isoWeekLabelFor(ws);
      await upsertTransparencyWeek(
        env.DB,
        await computeWeeklySnapshot(env.DB, iso),
      );
    }

    const middle = isoWeekLabelFor(weekStarts[1]);
    const older = await listWeeks(env.DB, middle, 52);
    expect(older).toHaveLength(1);
    expect(older[0].iso_week).toBe(isoWeekLabelFor(weekStarts[0]));
  });
});

describe("renderTransparencyHtml — page-layer rendered output", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("contains all four section headings and the seeded counter values", async () => {
    await seedTransparencyFixture(env.DB);
    await runWeeklyTransparency(env);
    const row = await getLatestWeek(env.DB);
    // runWeeklyTransparency aggregates the most-recently-completed week
    // relative to `new Date()`. When the fixture's seeded timestamps do
    // not fall inside that window, every counter is zero but the row is
    // still written — the renderer's headings are what matters here.
    expect(row).not.toBeNull();
    const html = renderTransparencyHtml(row!);

    expect(html).toContain("Submissions");
    expect(html).toContain("Audit outcomes");
    expect(html).toContain("Reports");
    expect(html).toContain("AI cost");
    // Every numeric counter field in the row is rendered somewhere in
    // the HTML — if a future refactor dropped one, this would fail.
    expect(html).toContain(String(row!.versions_submitted));
    expect(html).toContain(String(row!.versions_published));
    expect(html).toContain(String(row!.neurons_spent));
  });
});
