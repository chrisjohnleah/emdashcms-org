/**
 * Shared seed fixture for the Phase 15 transparency aggregation tests.
 *
 * Inserts a deterministic dataset with IDENTIFYING_TOKENS embedded in
 * authors, plugins, plugin_versions, plugin_audits, reports, and
 * audit_budget so the anonymization tests can scan transparency_weeks
 * rows and renderTransparencyHtml output for any leakage.
 *
 * Every token contains the substring `TEST-` so a single grep over the
 * rendered output is unambiguous.
 */

export const IDENTIFYING_TOKENS: string[] = [
  "plugin-id-TEST-f3a9c1",
  "plugin-id-TEST-9k2bcd",
  "author-name-TEST-BobbyTables",
  "author-name-TEST-AliceAdmin",
  "version-TEST-3.14.159",
  "version-TEST-2.71828",
  "report-desc-TEST-sekrit",
  "reporter-id-TEST-charlie",
];

export interface SeedOptions {
  /**
   * Sunday 00:00 UTC marking the start of the seeded transparency window.
   * The fixture inserts rows with timestamps inside [weekStart, weekStart+7d).
   * Defaults to Sunday 2026-04-05 00:00:00 UTC (a real Sunday).
   */
  weekStart?: Date;
}

export interface SeededWeek {
  weekStart: Date;
  weekEnd: Date;
}

const PLUGIN_A = "plugin-id-TEST-f3a9c1";
const PLUGIN_B = "plugin-id-TEST-9k2bcd";
const AUTHOR_A = "author-id-TEST-bobby";
const AUTHOR_B = "author-id-TEST-alice";
const REPORTER = "reporter-id-TEST-charlie";

/**
 * Seed two authors, two plugins, three plugin_versions (one published,
 * one rejected, one revoked), one plugin_audits row backing each version
 * (the revoked one uses model='admin-action' to mirror the production
 * revoke-version path), three reports (security/abuse/broken with two
 * resolved/dismissed), and an audit_budget row of 4242 neurons for the
 * weekStart date.
 *
 * Returns the resolved week bounds so the calling test can pass the
 * exact same window into computeWeeklySnapshot.
 */
export async function seedTransparencyFixture(
  db: D1Database,
  opts: SeedOptions = {},
): Promise<SeededWeek> {
  const weekStart = opts.weekStart ?? new Date(Date.UTC(2026, 3, 5, 0, 0, 0)); // Sun Apr 5 2026
  if (weekStart.getUTCDay() !== 0) {
    throw new Error(
      `seedTransparencyFixture: weekStart must be a Sunday 00:00 UTC, got UTC day ${weekStart.getUTCDay()}`,
    );
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  // Pick three timestamps clearly inside the window: Mon, Wed, Fri 12:00 UTC.
  const monday = new Date(weekStart);
  monday.setUTCDate(monday.getUTCDate() + 1);
  monday.setUTCHours(12, 0, 0, 0);
  const wednesday = new Date(weekStart);
  wednesday.setUTCDate(wednesday.getUTCDate() + 3);
  wednesday.setUTCHours(12, 0, 0, 0);
  const friday = new Date(weekStart);
  friday.setUTCDate(friday.getUTCDate() + 5);
  friday.setUTCHours(12, 0, 0, 0);

  const mondayIso = monday.toISOString();
  const wednesdayIso = wednesday.toISOString();
  const fridayIso = friday.toISOString();
  const weekStartDate = weekStart.toISOString().slice(0, 10); // YYYY-MM-DD

  const VERSION_PUBLISHED = "ver-id-TEST-published";
  const VERSION_REJECTED = "ver-id-TEST-rejected";
  const VERSION_REVOKED = "ver-id-TEST-revoked";

  await db.batch([
    // Authors — github_id must be unique per author. Use deterministic ids.
    db.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      AUTHOR_A,
      9300001,
      "author-name-TEST-BobbyTables",
      `https://avatars.githubusercontent.com/u/9300001`,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ),
    db.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      AUTHOR_B,
      9300002,
      "author-name-TEST-AliceAdmin",
      `https://avatars.githubusercontent.com/u/9300002`,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ),
    // Reporter author — used for the security report
    db.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      REPORTER,
      9300003,
      "reporter-username-TEST-charlie",
      `https://avatars.githubusercontent.com/u/9300003`,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ),
    // Plugins
    db.prepare(
      `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      PLUGIN_A,
      AUTHOR_A,
      "Plugin TEST A",
      "test plugin A",
      "[]",
      "[]",
      0,
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    ),
    db.prepare(
      `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      PLUGIN_B,
      AUTHOR_B,
      "Plugin TEST B",
      "test plugin B",
      "[]",
      "[]",
      0,
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    ),
    // Three plugin_versions — submitted IN window. Published / rejected / revoked.
    db.prepare(
      `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, checksum, created_at, updated_at)
       VALUES (?, ?, ?, 'published', ?, '{}', '', ?, ?)`,
    ).bind(
      VERSION_PUBLISHED,
      PLUGIN_A,
      "version-TEST-3.14.159",
      `bundles/${PLUGIN_A}/version-TEST-3.14.159.tar.gz`,
      mondayIso,
      mondayIso,
    ),
    db.prepare(
      `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, checksum, created_at, updated_at)
       VALUES (?, ?, ?, 'rejected', ?, '{}', '', ?, ?)`,
    ).bind(
      VERSION_REJECTED,
      PLUGIN_B,
      "version-TEST-2.71828",
      `bundles/${PLUGIN_B}/version-TEST-2.71828.tar.gz`,
      wednesdayIso,
      wednesdayIso,
    ),
    db.prepare(
      `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, checksum, created_at, updated_at)
       VALUES (?, ?, ?, 'revoked', ?, '{}', '', ?, ?)`,
    ).bind(
      VERSION_REVOKED,
      PLUGIN_A,
      "version-TEST-1.2.3",
      `bundles/${PLUGIN_A}/version-TEST-1.2.3.tar.gz`,
      fridayIso,
      fridayIso,
    ),
    // plugin_audits — one complete audit per version, all in window.
    // Revoked version gets an additional model='admin-action' row.
    db.prepare(
      `INSERT INTO plugin_audits (id, plugin_version_id, status, model, verdict, created_at)
       VALUES (?, ?, 'complete', 'gemma', 'pass', ?)`,
    ).bind("audit-TEST-1", VERSION_PUBLISHED, mondayIso),
    db.prepare(
      `INSERT INTO plugin_audits (id, plugin_version_id, status, model, verdict, created_at)
       VALUES (?, ?, 'complete', 'gemma', 'fail', ?)`,
    ).bind("audit-TEST-2", VERSION_REJECTED, wednesdayIso),
    db.prepare(
      `INSERT INTO plugin_audits (id, plugin_version_id, status, model, verdict, created_at)
       VALUES (?, ?, 'complete', 'gemma', 'pass', ?)`,
    ).bind("audit-TEST-3", VERSION_REVOKED, fridayIso),
    db.prepare(
      `INSERT INTO plugin_audits (id, plugin_version_id, status, model, verdict, created_at)
       VALUES (?, ?, 'complete', 'admin-action', 'fail', ?)`,
    ).bind("audit-TEST-4-revoke", VERSION_REVOKED, fridayIso),
    // Reports — security (open), abuse (resolved), broken (dismissed).
    db.prepare(
      `INSERT INTO reports (id, entity_type, entity_id, reporter_author_id, reason_category, description, status, created_at)
       VALUES (?, 'plugin', ?, ?, 'security', ?, 'open', ?)`,
    ).bind(
      "report-TEST-sec",
      PLUGIN_A,
      REPORTER,
      "report-desc-TEST-sekrit",
      mondayIso,
    ),
    db.prepare(
      `INSERT INTO reports (id, entity_type, entity_id, reporter_author_id, reason_category, description, status, resolved_at, created_at)
       VALUES (?, 'plugin', ?, ?, 'abuse', 'abuse desc', 'resolved', ?, ?)`,
    ).bind(
      "report-TEST-abuse",
      PLUGIN_B,
      REPORTER,
      wednesdayIso,
      mondayIso,
    ),
    db.prepare(
      `INSERT INTO reports (id, entity_type, entity_id, reporter_author_id, reason_category, description, status, resolved_at, created_at)
       VALUES (?, 'plugin', ?, ?, 'broken', 'broken desc', 'dismissed', ?, ?)`,
    ).bind(
      "report-TEST-broken",
      PLUGIN_A,
      REPORTER,
      fridayIso,
      wednesdayIso,
    ),
    // Audit budget — neurons spent on the Monday inside the window.
    db.prepare(
      `INSERT INTO audit_budget (date, neurons_used) VALUES (?, ?)`,
    ).bind(weekStartDate, 4242),
  ]);

  return { weekStart, weekEnd };
}
