import { describe, it, expect } from "vitest";
import {
  getIsoWeek,
  parseIsoWeekSlug,
  formatHumanRange,
} from "../../../src/lib/feeds/iso-week";

// Coverage for 14-CONTEXT.md D-23/D-24 and 14-RESEARCH.md §3.2 vectors.

describe("getIsoWeek", () => {
  it("2026-04-08T12:00:00Z -> 2026-W15 (mid-week sanity)", () => {
    expect(getIsoWeek(new Date("2026-04-08T12:00:00Z")).slug).toBe("2026-W15");
  });

  it("2024-12-30T00:00:00Z -> 2025-W01 (late Dec rolls forward)", () => {
    expect(getIsoWeek(new Date("2024-12-30T00:00:00Z")).slug).toBe("2025-W01");
  });

  it("2024-12-31T23:00:00Z -> 2025-W01", () => {
    expect(getIsoWeek(new Date("2024-12-31T23:00:00Z")).slug).toBe("2025-W01");
  });

  it("2025-01-01T00:00:00Z -> 2025-W01", () => {
    expect(getIsoWeek(new Date("2025-01-01T00:00:00Z")).slug).toBe("2025-W01");
  });

  it("2021-01-01T00:00:00Z -> 2020-W53 (early Jan rolls back; 2020 is 53-week year)", () => {
    expect(getIsoWeek(new Date("2021-01-01T00:00:00Z")).slug).toBe("2020-W53");
  });

  it("2021-01-03T23:59:59Z -> 2020-W53", () => {
    expect(getIsoWeek(new Date("2021-01-03T23:59:59Z")).slug).toBe("2020-W53");
  });

  it("2021-01-04T00:00:00Z -> 2021-W01", () => {
    expect(getIsoWeek(new Date("2021-01-04T00:00:00Z")).slug).toBe("2021-W01");
  });

  it("2020-12-28T00:00:00Z -> 2020-W53", () => {
    expect(getIsoWeek(new Date("2020-12-28T00:00:00Z")).slug).toBe("2020-W53");
  });

  it("2026-01-05T00:00:00Z -> 2026-W02", () => {
    expect(getIsoWeek(new Date("2026-01-05T00:00:00Z")).slug).toBe("2026-W02");
  });

  it("2026-12-31T23:59:59Z -> 2026-W53 (2026 is a 53-week year)", () => {
    expect(getIsoWeek(new Date("2026-12-31T23:59:59Z")).slug).toBe("2026-W53");
  });

  it("Sunday 2026-04-12T00:05:00Z -> 2026-W15 (D-24 reference: cron firing 2026-04-19T00:05Z minus 7d)", () => {
    expect(getIsoWeek(new Date("2026-04-12T00:05:00Z")).slug).toBe("2026-W15");
  });

  it("Sunday 2025-12-28T00:05:00Z -> 2025-W52 (D-24 year-boundary reference for cron firing 2026-01-04T00:05Z)", () => {
    expect(getIsoWeek(new Date("2025-12-28T00:05:00Z")).slug).toBe("2025-W52");
  });

  it("returns startUtc as Monday 00:00:00.000Z of the ISO week", () => {
    const week = getIsoWeek(new Date("2026-04-08T12:00:00Z"));
    expect(week.startUtc).toBe("2026-04-06T00:00:00.000Z");
  });

  it("returns endUtc as Sunday 23:59:59.999Z of the ISO week", () => {
    const week = getIsoWeek(new Date("2026-04-08T12:00:00Z"));
    expect(week.endUtc).toBe("2026-04-12T23:59:59.999Z");
  });

  it("slug is zero-padded two-digit week number (2026-W02 not 2026-W2)", () => {
    expect(getIsoWeek(new Date("2026-01-05T00:00:00Z")).slug).toBe("2026-W02");
    expect(/^\d{4}-W\d{2}$/.test(getIsoWeek(new Date("2026-01-05T00:00:00Z")).slug)).toBe(true);
  });

  it("populates year/week fields on the IsoWeek result", () => {
    const week = getIsoWeek(new Date("2026-04-08T12:00:00Z"));
    expect(week.year).toBe(2026);
    expect(week.week).toBe(15);
  });
});

describe("parseIsoWeekSlug", () => {
  it("accepts 2026-W15 and returns matching IsoWeek", () => {
    const parsed = parseIsoWeekSlug("2026-W15");
    expect(parsed).not.toBeNull();
    expect(parsed!.year).toBe(2026);
    expect(parsed!.week).toBe(15);
    expect(parsed!.slug).toBe("2026-W15");
  });

  it('rejects malformed slugs ("2026-15", "2026W15", "26-W15", "2026-W99", "") -> null', () => {
    expect(parseIsoWeekSlug("2026-15")).toBeNull();
    expect(parseIsoWeekSlug("2026W15")).toBeNull();
    expect(parseIsoWeekSlug("26-W15")).toBeNull();
    expect(parseIsoWeekSlug("2026-W99")).toBeNull();
    expect(parseIsoWeekSlug("")).toBeNull();
  });

  it("rejects 2026-W54 (no such week) -> null", () => {
    expect(parseIsoWeekSlug("2026-W54")).toBeNull();
  });

  it("accepts 53-week years (2020-W53, 2026-W53)", () => {
    expect(parseIsoWeekSlug("2020-W53")).not.toBeNull();
    expect(parseIsoWeekSlug("2026-W53")).not.toBeNull();
  });

  it("rejects W53 for non-53-week years (e.g. 2025-W53)", () => {
    // 2025 has 52 weeks — its W53 does not exist.
    expect(parseIsoWeekSlug("2025-W53")).toBeNull();
  });
});

describe("formatHumanRange", () => {
  it('formats 2026-W15 as a UTC-safe readable range (e.g. "Apr 6–12, 2026")', () => {
    const week = getIsoWeek(new Date("2026-04-08T12:00:00Z"));
    const label = formatHumanRange(week);
    expect(label).toContain("Apr");
    expect(label).toContain("2026");
    expect(label).toContain("6");
    expect(label).toContain("12");
    // En-dash, not hyphen
    expect(label).toContain("\u2013");
  });

  it("formats a month-spanning week with both month names", () => {
    // 2024-12-30 Monday starts a week that crosses into January
    const week = getIsoWeek(new Date("2024-12-30T12:00:00Z"));
    const label = formatHumanRange(week);
    expect(label).toContain("Dec");
    expect(label).toContain("Jan");
  });
});
