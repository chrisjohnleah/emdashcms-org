import { describe, it } from "vitest";
// Coverage for 14-CONTEXT.md D-23/D-24 and 14-RESEARCH.md §3.2 vectors.
describe("getIsoWeek", () => {
  it.todo("2026-04-08T12:00:00Z -> 2026-W15 (mid-week sanity)");
  it.todo("2024-12-30T00:00:00Z -> 2025-W01 (late Dec rolls forward)");
  it.todo("2024-12-31T23:00:00Z -> 2025-W01");
  it.todo("2025-01-01T00:00:00Z -> 2025-W01");
  it.todo("2021-01-01T00:00:00Z -> 2020-W53 (early Jan rolls back)");
  it.todo("2021-01-03T23:59:59Z -> 2020-W53");
  it.todo("2021-01-04T00:00:00Z -> 2021-W01");
  it.todo("2020-12-28T00:00:00Z -> 2020-W53");
  it.todo("2026-01-05T00:00:00Z -> 2026-W02");
  it.todo("2026-12-31T23:59:59Z -> 2026-W53");
  it.todo(
    "Sunday 2026-04-12T00:05:00Z -> 2026-W15 (D-24 reference: cron firing 2026-04-19T00:05Z minus 7d)",
  );
  it.todo(
    "Sunday 2025-12-28T00:05:00Z -> 2025-W52 (D-24 year-boundary reference for cron firing 2026-01-04T00:05Z)",
  );
  it.todo("returns startUtc as Monday 00:00:00.000Z of the ISO week");
  it.todo("returns endUtc as Sunday 23:59:59.999Z of the ISO week");
  it.todo("slug is zero-padded two-digit week number (2026-W02 not 2026-W2)");
});
describe("parseIsoWeekSlug", () => {
  it.todo("accepts 2026-W15 and returns matching IsoWeek");
  it.todo(
    'rejects malformed slugs ("2026-15", "2026W15", "26-W15", "2026-W99", "") -> null',
  );
  it.todo("rejects 2026-W54 (no such week) -> null");
});
describe("formatHumanRange", () => {
  it.todo(
    'formats 2026-W15 as a UTC-safe readable range (e.g. "Apr 6–12, 2026")',
  );
});
