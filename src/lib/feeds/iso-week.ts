// Phase 14: ISO 8601 week math per 14-CONTEXT.md D-23.
//
// ISO 8601 defines Week 1 as the week containing the first Thursday of
// the year (equivalently, the week containing January 4). Weeks run
// Monday to Sunday. The ISO week-numbering year is NOT always the
// calendar year: late December dates can belong to W01 of the following
// year, and early January dates can belong to W53 of the previous year.
//
// This module is pure — zero dependencies, UTC only, deterministic.

export interface IsoWeek {
  /** ISO 8601 week-numbering year (may differ from calendar year). */
  year: number;
  /** Week number in the ISO year, 1..53. */
  week: number;
  /** Canonical slug, zero-padded: "YYYY-Www" (e.g. "2026-W15"). */
  slug: string;
  /** Monday 00:00:00.000 UTC of the ISO week, ISO8601 string. */
  startUtc: string;
  /** Sunday 23:59:59.999 UTC of the ISO week, ISO8601 string. */
  endUtc: string;
}

/** ISO weekday: Monday=1 .. Sunday=7. */
function isoDayOfWeek(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/** Given a Date, return the ISO 8601 week it falls in. */
export function getIsoWeek(input: Date): IsoWeek {
  // Work entirely in UTC. Copy-and-zero the time so arithmetic is stable.
  const day = new Date(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
  );

  const dow = isoDayOfWeek(day);

  // Step to the Thursday of this ISO week — its calendar year IS the ISO
  // week-numbering year, by definition.
  const thursday = new Date(day);
  thursday.setUTCDate(day.getUTCDate() + 4 - dow);
  const isoYear = thursday.getUTCFullYear();

  // January 4 is ALWAYS in W01 of its ISO year.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = isoDayOfWeek(jan4);
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - (jan4Dow - 1)));

  // Week number = how many weeks from W01-Monday to this week's Thursday.
  const week =
    Math.floor((thursday.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) +
    1;

  // This ISO week's Monday (from the input date's calendar position).
  const thisWeekMonday = new Date(
    Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate() - (dow - 1),
    ),
  );
  const thisWeekSunday = new Date(thisWeekMonday);
  thisWeekSunday.setUTCDate(thisWeekMonday.getUTCDate() + 6);
  thisWeekSunday.setUTCHours(23, 59, 59, 999);

  return {
    year: isoYear,
    week,
    slug: `${isoYear}-W${String(week).padStart(2, "0")}`,
    startUtc: thisWeekMonday.toISOString(),
    endUtc: thisWeekSunday.toISOString(),
  };
}

/** Parse a "YYYY-Www" slug; return null on any syntactic or semantic issue. */
export function parseIsoWeekSlug(slug: string): IsoWeek | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(slug);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const week = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  if (week < 1 || week > 53) return null;

  // Semantic validation: synthesize the Monday of that ISO week and round-trip
  // through getIsoWeek. If the result disagrees, the requested week does not
  // exist for that year (e.g. 2026-W54, or non-53-week years asking for W53).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = isoDayOfWeek(jan4);
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4Dow - 1)));
  const candidate = new Date(week1Monday);
  candidate.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  const roundTrip = getIsoWeek(candidate);
  if (roundTrip.slug !== slug) return null;
  return roundTrip;
}

/**
 * Render a human-readable UTC date range for an ISO week.
 *   - Same month: "Apr 6–12, 2026"
 *   - Crosses month: "Dec 30, 2024 – Jan 5, 2025"
 * Always uses en-dash, always UTC, no locale surprises.
 */
export function formatHumanRange(week: IsoWeek): string {
  const start = new Date(week.startUtc);
  const end = new Date(week.endUtc);

  const monthFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
  });
  const startMonth = monthFmt.format(start);
  const endMonth = monthFmt.format(end);
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();

  if (startMonth === endMonth && startYear === endYear) {
    return `${startMonth} ${startDay}\u2013${endDay}, ${startYear}`;
  }
  if (startYear === endYear) {
    return `${startMonth} ${startDay} \u2013 ${endMonth} ${endDay}, ${startYear}`;
  }
  return `${startMonth} ${startDay}, ${startYear} \u2013 ${endMonth} ${endDay}, ${endYear}`;
}
