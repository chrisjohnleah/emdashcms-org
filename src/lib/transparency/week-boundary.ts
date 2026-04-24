/**
 * ISO-week helpers for the Phase 15 transparency aggregation.
 *
 * Per 15-CONTEXT D-02 / D-03 the marketplace runs a Sunday→Sunday
 * window, but labels each window with the ISO 8601 week number of the
 * Sunday's preceding Thursday. That keeps year-boundary cases
 * (e.g. 2021-01-03 Sunday → 2020-W53) consistent with what observers
 * expect from `YYYY-Www` slugs while preserving the simpler
 * Sunday-anchored aggregation window the cron actually computes over.
 */

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Given a Sunday 00:00 UTC (start of our non-standard week), return the
 * ISO-style week label per D-03: the ISO week number of that Sunday's
 * preceding Thursday, formatted YYYY-Www.
 */
export function isoWeekLabelFor(sundayUtc: Date): string {
  if (sundayUtc.getUTCDay() !== 0) {
    throw new Error(
      `isoWeekLabelFor expected a Sunday, got UTC day ${sundayUtc.getUTCDay()}`,
    );
  }
  const thursday = new Date(sundayUtc);
  thursday.setUTCDate(thursday.getUTCDate() - 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // Sun(0) → 7 for ISO arithmetic
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() + (4 - jan4Dow));
  const weekNumber =
    Math.round((thursday.getTime() - firstThursday.getTime()) / MS_PER_WEEK) +
    1;
  return `${isoYear}-W${String(weekNumber).padStart(2, "0")}`;
}

/**
 * Inverse: given an ISO week label, return the Sunday→Sunday window
 * bounds (start inclusive, end exclusive).
 */
export function weekBoundsFor(isoWeek: string): { start: Date; end: Date } {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`Invalid iso week label: ${isoWeek}`);
  const isoYear = parseInt(match[1], 10);
  const weekNum = parseInt(match[2], 10);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() + (4 - jan4Dow));
  const targetThursday = new Date(firstThursday);
  targetThursday.setUTCDate(firstThursday.getUTCDate() + (weekNum - 1) * 7);
  // Sunday that starts our window = Thursday + 3 days (then anchored to 00:00 UTC).
  const start = new Date(targetThursday);
  start.setUTCDate(targetThursday.getUTCDate() + 3);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

export function previousWeek(isoWeek: string): string {
  const { start } = weekBoundsFor(isoWeek);
  const prevSunday = new Date(start);
  prevSunday.setUTCDate(prevSunday.getUTCDate() - 7);
  return isoWeekLabelFor(prevSunday);
}

export function nextWeek(isoWeek: string): string {
  const { end } = weekBoundsFor(isoWeek);
  // `end` IS the next Sunday (exclusive end of this week == inclusive
  // start of next), so labelling it gives us the next week.
  return isoWeekLabelFor(end);
}

/**
 * Given a `now` Date, return the iso_week label of the week that MOST
 * RECENTLY COMPLETED — i.e. the week whose end Sunday is the most
 * recent Sunday 00:00 UTC at or before `now`. Used by the Sunday 00:10
 * UTC cron to aggregate the PRECEDING week.
 */
export function mostRecentCompletedWeek(now: Date): string {
  const dayOfWeek = now.getUTCDay(); // Sun=0..Sat=6
  const mostRecentSunday = new Date(now);
  mostRecentSunday.setUTCHours(0, 0, 0, 0);
  mostRecentSunday.setUTCDate(mostRecentSunday.getUTCDate() - dayOfWeek);
  // That Sunday is the END of our completed window. Start is 7 days earlier.
  const start = new Date(mostRecentSunday);
  start.setUTCDate(start.getUTCDate() - 7);
  return isoWeekLabelFor(start);
}
