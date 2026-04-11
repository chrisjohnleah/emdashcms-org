// Phase 14: Weekly digest snapshot + cron entrypoint.
//
// Fires every Sunday 00:05 UTC via the scheduled() handler in src/worker.ts
// and writes one row to weekly_digests (primary key: iso_week). The written
// manifest_json is self-contained per D-19/D-20 so /digest/[slug] can render
// an archived week without ever touching the live plugins/themes tables.
//
// See 14-CONTEXT.md D-19..D-28 and 14-RESEARCH.md §8 for the design.

import { getIsoWeek, type IsoWeek } from "./iso-week";

export interface WeeklyDigestManifest {
  version: 1;
  isoWeek: string;
  windowStartUtc: string;
  windowEndUtc: string;
  newPlugins: Array<{
    id: string;
    name: string;
    category: string | null;
    shortDescription: string | null;
    authorLogin: string;
    createdAt: string;
  }>;
  updatedPlugins: Array<{
    pluginId: string;
    name: string;
    version: string;
    authorLogin: string;
    publishedAt: string;
  }>;
  newThemes: Array<{
    id: string;
    name: string;
    shortDescription: string | null;
    authorLogin: string;
    createdAt: string;
  }>;
  counts: {
    newPlugins: number;
    updatedPlugins: number;
    newThemes: number;
  };
}

// ---------------------------------------------------------------------------
// 14-RESEARCH.md §8.1 — window-bounded snapshot queries. These are NEW
// window queries (not reused from feed-queries.ts, which ships "N most
// recent" shapes only — see 14-01-SUMMARY handoff notes).
// ---------------------------------------------------------------------------

const NEW_PLUGINS_SQL = `
  SELECT p.id, p.name, p.category, p.short_description, p.created_at,
         a.github_username AS author_login
  FROM plugins p
  JOIN authors a ON a.id = p.author_id
  WHERE p.created_at >= ? AND p.created_at <= ?
    AND COALESCE(p.status, 'active') = 'active'
    AND EXISTS (
      SELECT 1 FROM plugin_versions pv
      WHERE pv.plugin_id = p.id AND pv.status IN ('published', 'flagged')
    )
  ORDER BY p.created_at DESC
`;

const UPDATED_VERSIONS_SQL = `
  SELECT pv.version,
         COALESCE(pv.published_at, pv.created_at) AS sort_ts,
         p.id AS plugin_id, p.name,
         a.github_username AS author_login
  FROM plugin_versions pv
  JOIN plugins p ON p.id = pv.plugin_id
  JOIN authors a ON a.id = p.author_id
  WHERE pv.status IN ('published', 'flagged')
    AND COALESCE(pv.published_at, pv.created_at) >= ?
    AND COALESCE(pv.published_at, pv.created_at) <= ?
  ORDER BY COALESCE(pv.published_at, pv.created_at) DESC
`;

const NEW_THEMES_SQL = `
  SELECT t.id, t.name, t.short_description, t.created_at,
         a.github_username AS author_login
  FROM themes t
  JOIN authors a ON a.id = t.author_id
  WHERE t.created_at >= ? AND t.created_at <= ?
    AND (t.repository_url IS NOT NULL OR t.npm_package IS NOT NULL)
  ORDER BY t.created_at DESC
`;

export async function snapshotWeek(
  db: D1Database,
  week: IsoWeek,
): Promise<WeeklyDigestManifest> {
  const [newPluginsR, updatedVersionsR, newThemesR] = await db.batch([
    db.prepare(NEW_PLUGINS_SQL).bind(week.startUtc, week.endUtc),
    db.prepare(UPDATED_VERSIONS_SQL).bind(week.startUtc, week.endUtc),
    db.prepare(NEW_THEMES_SQL).bind(week.startUtc, week.endUtc),
  ]);

  const newPlugins = ((newPluginsR.results ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
      id: r.id as string,
      name: r.name as string,
      category: (r.category as string | null) ?? null,
      shortDescription: (r.short_description as string | null) ?? null,
      authorLogin: r.author_login as string,
      createdAt: r.created_at as string,
    }),
  );

  const updatedPlugins = (
    (updatedVersionsR.results ?? []) as Array<Record<string, unknown>>
  ).map((r) => ({
    pluginId: r.plugin_id as string,
    name: r.name as string,
    version: r.version as string,
    authorLogin: r.author_login as string,
    publishedAt: r.sort_ts as string,
  }));

  const newThemes = ((newThemesR.results ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
      id: r.id as string,
      name: r.name as string,
      shortDescription: (r.short_description as string | null) ?? null,
      authorLogin: r.author_login as string,
      createdAt: r.created_at as string,
    }),
  );

  return {
    version: 1,
    isoWeek: week.slug,
    windowStartUtc: week.startUtc,
    windowEndUtc: week.endUtc,
    newPlugins,
    updatedPlugins,
    newThemes,
    counts: {
      newPlugins: newPlugins.length,
      updatedPlugins: updatedPlugins.length,
      newThemes: newThemes.length,
    },
  };
}

export async function runWeeklyDigest(
  env: { DB: D1Database },
  now: Date = new Date(),
): Promise<void> {
  // D-24: compute the week that just ENDED. The cron fires Sunday 00:05 UTC,
  // but at that instant we're still inside the CURRENT ISO week (Sunday is
  // the last day of the ISO week, so it belongs to it). Subtracting exactly
  // 7 days lands the reference inside the fully-completed prior ISO week,
  // regardless of any minor cron drift. This also sidesteps year-boundary
  // edge cases (W53 → W01) automatically because getIsoWeek does the heavy
  // lifting. A 1-hour subtraction would leave us in the current week and
  // orphan ~24h of data — do not change the factor.
  const reference = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const week = getIsoWeek(reference);

  // Worked example for the cron firing at Sunday 2026-04-19T00:05:00Z:
  //   reference        = 2026-04-12T00:05:00.000Z (Sunday, 7 days earlier)
  //   getIsoWeek(ref)  = { year: 2026, week: 15,
  //                        startUtc: '2026-04-06T00:00:00.000Z',
  //                        endUtc:   '2026-04-12T23:59:59.999Z' }
  //   week.slug        = '2026-W15'
  //
  // Year-boundary worked example for Sunday 2026-01-04T00:05:00Z:
  //   reference        = 2025-12-28T00:05:00.000Z (Sunday, in 2025-W52)
  //   getIsoWeek(ref)  = { year: 2025, week: 52, ... }
  //   week.slug        = '2025-W52'
  const manifest = await snapshotWeek(env.DB, week);
  const manifestJson = JSON.stringify(manifest);

  // D-25: INSERT OR REPLACE on the iso_week PK makes the generator idempotent
  // — any re-run for the same week overwrites the same row in place.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO weekly_digests (iso_week, generated_at, manifest_json)
     VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)`,
  )
    .bind(week.slug, manifestJson)
    .run();

  console.log(
    `[weekly-digest] wrote ${week.slug} — ` +
      `${manifest.counts.newPlugins}np ${manifest.counts.updatedPlugins}up ${manifest.counts.newThemes}nt`,
  );
}
