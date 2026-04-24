import { describe, it, expect } from "vitest";
import {
  isoWeekLabelFor,
  weekBoundsFor,
  previousWeek,
  nextWeek,
  mostRecentCompletedWeek,
} from "../../../src/lib/transparency/week-boundary";

// Phase 15 D-02 / D-03 — Sunday→Sunday windows; iso_week label = ISO week
// of the Sunday's preceding Thursday so year-rollover cases match the
// Wikipedia ISO week table (e.g. 2021-01-03 belongs to 2020-W53).

describe("isoWeekLabelFor", () => {
  it("labels Sunday 2026-01-04 as 2026-W01", () => {
    expect(isoWeekLabelFor(new Date(Date.UTC(2026, 0, 4)))).toBe("2026-W01");
  });

  it("labels Sunday 2026-04-12 as 2026-W15", () => {
    expect(isoWeekLabelFor(new Date(Date.UTC(2026, 3, 12)))).toBe("2026-W15");
  });

  it("labels Sunday 2025-12-28 as 2025-W52", () => {
    expect(isoWeekLabelFor(new Date(Date.UTC(2025, 11, 28)))).toBe("2025-W52");
  });

  it("labels Sunday 2021-01-03 as 2020-W53", () => {
    expect(isoWeekLabelFor(new Date(Date.UTC(2021, 0, 3)))).toBe("2020-W53");
  });

  it("throws on a non-Sunday input", () => {
    // Monday 2026-04-13
    expect(() => isoWeekLabelFor(new Date(Date.UTC(2026, 3, 13)))).toThrow(
      /Sunday/,
    );
  });
});

describe("weekBoundsFor round-trip", () => {
  for (const label of ["2026-W01", "2026-W15", "2025-W52", "2020-W53"]) {
    it(`round-trips ${label}`, () => {
      const { start } = weekBoundsFor(label);
      expect(isoWeekLabelFor(start)).toBe(label);
    });
  }

  it("returns a window of exactly 7 days (UTC)", () => {
    const { start, end } = weekBoundsFor("2026-W15");
    const ms = end.getTime() - start.getTime();
    expect(ms).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("previousWeek / nextWeek", () => {
  it("previousWeek('2026-W15') === '2026-W14'", () => {
    expect(previousWeek("2026-W15")).toBe("2026-W14");
  });

  it("nextWeek('2026-W15') === '2026-W16'", () => {
    expect(nextWeek("2026-W15")).toBe("2026-W16");
  });

  it("previousWeek('2026-W01') crosses year boundary to '2025-W52'", () => {
    expect(previousWeek("2026-W01")).toBe("2025-W52");
  });
});

describe("mostRecentCompletedWeek", () => {
  it("on Sunday 2026-04-12 00:10 UTC returns 2026-W14 (the just-ended Apr 5 → Apr 12 window)", () => {
    const sundayJustAfterMidnight = new Date(Date.UTC(2026, 3, 12, 0, 10, 0));
    expect(mostRecentCompletedWeek(sundayJustAfterMidnight)).toBe("2026-W14");
  });

  it("on Wednesday 2026-04-15 returns 2026-W14 (still the most recently completed week)", () => {
    const wednesday = new Date(Date.UTC(2026, 3, 15, 9, 0, 0));
    expect(mostRecentCompletedWeek(wednesday)).toBe("2026-W14");
  });
});
