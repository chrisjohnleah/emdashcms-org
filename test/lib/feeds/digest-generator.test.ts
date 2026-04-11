import { describe, it } from "vitest";
// Coverage for 14-CONTEXT.md D-19..D-28 (snapshot + idempotency) and FEED-05.

describe("runWeeklyDigest", () => {
  it.todo("computes the just-ended ISO week (getIsoWeek(now - 7 days) per D-24)");
  it.todo("writes exactly one row to weekly_digests per run");
  it.todo("is idempotent: running twice still leaves one row (INSERT OR REPLACE)");
  it.todo("manifest_json is valid JSON and parses as WeeklyDigestManifest");
  it.todo("manifest version is 1");
  it.todo("captures windowStartUtc / windowEndUtc from getIsoWeek(now - 7 days) per D-24");
  it.todo("newPlugins captures plugins created within the window only");
  it.todo("newPlugins excludes plugins with no published/flagged version");
  it.todo("updatedPlugins captures one entry per published/flagged version in window");
  it.todo("updatedPlugins excludes pending/rejected/revoked versions");
  it.todo("newThemes captures themes created within the window with the active-theme filter");
  it.todo("counts object matches the length of each array");
  it.todo("empty week writes a row with three empty arrays and zero counts");
  it.todo("runWeeklyDigest(env, new Date('2026-04-19T00:05:00Z')) writes iso_week=2026-W15");
  it.todo("runWeeklyDigest(env, new Date('2026-01-04T00:05:00Z')) writes iso_week=2025-W52 (year-boundary robustness)");
});

describe("snapshotWeek", () => {
  it.todo("returns WeeklyDigestManifest for the given IsoWeek");
});
