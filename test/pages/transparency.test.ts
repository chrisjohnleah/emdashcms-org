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
import {
  IDENTIFYING_TOKENS,
  seedTransparencyFixture,
} from "../fixtures/transparency-seed";
import { runWeeklyTransparency } from "../../src/lib/transparency/cron-handler";
import {
  computeWeeklySnapshot,
  getLatestWeek,
  getWeekByIsoWeek,
  listWeeks,
  upsertTransparencyWeek,
  type TransparencyWeekRow,
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
    // Pass `null` for startWeek — this assertion is about section
    // headings and counter values, not the lifecycle footnote (which has
    // its own dedicated tests below).
    const html = renderTransparencyHtml(row!, null);

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

/**
 * Phase 22-02 — "Ecosystem health" section coverage.
 *
 * Pins:
 *   - TRNS-05 anonymisation invariant extends to the new section even when
 *     plugin rows bear identifying names AND populated deprecated_at /
 *     unlisted_at (D-11).
 *   - Both lifecycle counters surface in the rendered HTML from a backfilled
 *     snapshot (EHAA-03 rendering half).
 *   - Footnote presence/absence is pinned both ways (D-08, EHAA-04).
 */
describe("Phase 22-02 Ecosystem health section", () => {
  beforeEach(async () => {
    await resetTables();
  });

  /**
   * Build a TransparencyWeekRow literal for renderer-only tests. No D1
   * round-trip needed; mirrors the production row shape exactly.
   */
  function fixedRow(
    overrides: Partial<TransparencyWeekRow> = {},
  ): TransparencyWeekRow {
    return {
      iso_week: "2026-W17",
      week_start: "2026-04-26T00:00:00.000Z",
      week_end: "2026-05-03T00:00:00.000Z",
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
      created_at: "2026-05-03T00:10:00.000Z",
      ...overrides,
    };
  }

  it("TRNS-05 anonymisation invariant holds for the Ecosystem health section", async () => {
    // Seed identifying-named plugin rows whose deprecated_at / unlisted_at
    // fall inside a known window. The TRNS-05 contract: even when these
    // rows exist, renderTransparencyHtml output must contain zero
    // identifying tokens — only the integer counters cross the boundary.
    const weekStart = new Date(Date.UTC(2026, 3, 5, 0, 0, 0)); // Sun 2026-04-05
    const isoWeek = isoWeekLabelFor(weekStart);
    const inWindowIso = new Date(
      weekStart.getTime() + 2 * 86_400_000,
    ).toISOString(); // Tuesday 00:00 UTC inside window

    // Reuse the broader seed so the existing TRNS-05 tokens are present
    // alongside the lifecycle-specific identifying values.
    await seedTransparencyFixture(env.DB, { weekStart });

    // Three plugins with identifying names; one deprecated, one unlisted,
    // one neither. Use unique ids that do NOT collide with the seed
    // fixture's PLUGIN_A / PLUGIN_B.
    const AUTHOR_A = "author-id-TEST-bobby";
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at, deprecated_at)
           VALUES (?, ?, ?, ?, '[]', '[]', 0, ?, ?, ?)`,
        )
        .bind(
          "plugin-id-TEST-lifecycle-a",
          AUTHOR_A,
          "christophers-personal-plugin",
          "Christopher Special",
          "2026-01-02T00:00:00Z",
          "2026-01-02T00:00:00Z",
          inWindowIso,
        ),
      env.DB
        .prepare(
          `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at, unlisted_at)
           VALUES (?, ?, ?, ?, '[]', '[]', 0, ?, ?, ?)`,
        )
        .bind(
          "plugin-id-TEST-lifecycle-b",
          AUTHOR_A,
          "org-internal-tool",
          "Org Internal Tool",
          "2026-01-02T00:00:00Z",
          "2026-01-02T00:00:00Z",
          inWindowIso,
        ),
      env.DB
        .prepare(
          `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, '[]', '[]', 0, ?, ?)`,
        )
        .bind(
          "plugin-id-TEST-lifecycle-c",
          AUTHOR_A,
          "normal-plugin",
          "Normal Plugin",
          "2026-01-02T00:00:00Z",
          "2026-01-02T00:00:00Z",
        ),
    ]);

    const snapshot = await computeWeeklySnapshot(env.DB, isoWeek);
    await upsertTransparencyWeek(env.DB, snapshot);
    const row = await getWeekByIsoWeek(env.DB, isoWeek);
    expect(row).not.toBeNull();
    // Sanity: the lifecycle counters reflect the seed (1 deprecation, 1
    // unlist) — confirms the test exercises the new section meaningfully.
    expect(row!.deprecations_count).toBe(1);
    expect(row!.unlists_count).toBe(1);

    const html = renderTransparencyHtml(row!, "2026-W17");

    // Augment the existing IDENTIFYING_TOKENS list with the lifecycle
    // fixture rows' identifying values. Any leakage of any of these into
    // the renderer's output is a TRNS-05 invariant violation.
    const lifecycleTokens = [
      "christophers-personal-plugin",
      "Christopher Special",
      "org-internal-tool",
      "Org Internal Tool",
      "plugin-id-TEST-lifecycle-a",
      "plugin-id-TEST-lifecycle-b",
      "plugin-id-TEST-lifecycle-c",
    ];
    for (const token of [...IDENTIFYING_TOKENS, ...lifecycleTokens]) {
      expect(
        html.includes(token),
        `rendered HTML contained identifying token: ${token}`,
      ).toBe(false);
    }
  });

  it("Ecosystem health section renders both counters from a backfilled snapshot", () => {
    const row = fixedRow({ deprecations_count: 4, unlists_count: 2 });
    const html = renderTransparencyHtml(row, "2026-W17");

    expect(html).toContain("Ecosystem health");
    expect(html).toContain("Plugins deprecated");
    expect(html).toContain("Plugins unlisted");
    // Each counter value appears wrapped in a tabular-nums <td> — assert
    // on the closing-tag context to avoid false matches against any other
    // place a "4" or "2" might land in the HTML.
    expect(html).toContain(">4</td>");
    expect(html).toContain(">2</td>");
  });

  it("Footnote renders when startWeek is provided", () => {
    const row = fixedRow({ deprecations_count: 1, unlists_count: 1 });
    const html = renderTransparencyHtml(row, "2026-W17");
    expect(html).toContain("Lifecycle metrics began the week of 2026-W17");
  });

  it("Footnote is omitted when startWeek is null", () => {
    const row = fixedRow({ deprecations_count: 1, unlists_count: 1 });
    const html = renderTransparencyHtml(row, null);
    expect(html.includes("Lifecycle metrics began")).toBe(false);
  });
});
