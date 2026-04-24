/**
 * Pure D1 query module for status_samples plus the histogram helpers
 * the /status renderer consumes.
 *
 * Retention is enforced by enforceRetention(), called at the start of
 * every probe tick (15-CONTEXT D-26). The (surface, sampled_at DESC)
 * index supports both the per-surface 7-day query and the bounded
 * DELETE.
 */

import type { ProbeSample } from "./probe";

export interface StatusSampleRow {
  id: string;
  surface: string;
  sampled_at: string;
  status: "ok" | "slow" | "fail" | "timeout";
  http_status: number | null;
  latency_ms: number | null;
}

export interface HistogramBucket {
  bucketStart: string; // ISO timestamp, inclusive
  bucketEnd: string; // ISO timestamp, exclusive
  worstStatus: "ok" | "slow" | "fail" | "timeout" | "missing";
}

export async function insertSample(
  db: D1Database,
  sample: ProbeSample,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      sample.surface,
      sample.sampledAt,
      sample.status,
      sample.httpStatus,
      sample.latencyMs,
    )
    .run();
}

/**
 * Delete samples strictly older than the cutoff. Returns the number
 * of rows deleted (driven by D1's `meta.changes`).
 */
export async function enforceRetention(
  db: D1Database,
  cutoffIso: string,
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM status_samples WHERE sampled_at < ?`)
    .bind(cutoffIso)
    .run();
  return result.meta.changes ?? 0;
}

export async function getRecent7Days(
  db: D1Database,
  surface: string,
  now: Date = new Date(),
): Promise<StatusSampleRow[]> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const result = await db
    .prepare(
      `SELECT id, surface, sampled_at, status, http_status, latency_ms
       FROM status_samples
       WHERE surface = ? AND sampled_at >= ?
       ORDER BY sampled_at ASC`,
    )
    .bind(surface, cutoff)
    .all<StatusSampleRow>();
  return result.results;
}

export async function getAllSurfaces7Days(
  db: D1Database,
  now: Date = new Date(),
): Promise<Map<string, StatusSampleRow[]>> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const result = await db
    .prepare(
      `SELECT id, surface, sampled_at, status, http_status, latency_ms
       FROM status_samples
       WHERE sampled_at >= ?
       ORDER BY surface ASC, sampled_at ASC`,
    )
    .bind(cutoff)
    .all<StatusSampleRow>();
  const map = new Map<string, StatusSampleRow[]>();
  for (const row of result.results) {
    const list = map.get(row.surface) ?? [];
    list.push(row);
    map.set(row.surface, list);
  }
  return map;
}

/**
 * Returns uptime as a percent rounded to 2 decimal places. `null` when
 * there are no samples (the page renders this as an em-dash).
 */
export function computeUptimePercent(
  samples: StatusSampleRow[],
): number | null {
  if (samples.length === 0) return null;
  const ok = samples.filter((s) => s.status === "ok").length;
  return Math.round((ok / samples.length) * 10000) / 100;
}

/**
 * D-30 classification:
 *   - outage if any of the last 3 samples is fail/timeout
 *   - degraded if any of the last 3 is slow (and none fail/timeout)
 *   - ok otherwise
 *   - unknown if there are no samples at all
 */
export function classifyCurrent(
  samples: StatusSampleRow[],
): "ok" | "degraded" | "outage" | "unknown" {
  if (samples.length === 0) return "unknown";
  const lastThree = samples.slice(-3);
  if (lastThree.some((s) => s.status === "fail" || s.status === "timeout")) {
    return "outage";
  }
  if (lastThree.some((s) => s.status === "slow")) return "degraded";
  return "ok";
}

const BUCKET_COUNT = 84;
const STATUS_RANK = {
  missing: 0,
  ok: 1,
  slow: 2,
  timeout: 3,
  fail: 4,
} as const;

/**
 * Build exactly 84 histogram buckets ending at `now`, oldest-first.
 *
 * Each bucket spans `bucketWidthHours` hours. The default of 2 yields
 * a 168-hour (7-day) window — matching CONTEXT D-29's "84 bars × 2h
 * = 7 days" header. Bucket count is FIXED at 84 — only the bucket
 * width changes when callers pass a different value.
 *
 * Resolution within a bucket is worst-wins: fail > timeout > slow > ok.
 * Buckets with no samples in the window are 'missing'.
 */
export function buildHistogramBuckets(
  samples: StatusSampleRow[],
  now: Date = new Date(),
  bucketWidthHours: number = 2,
): HistogramBucket[] {
  const bucketMs = bucketWidthHours * 60 * 60_000;
  // Align `now` to the top of the current hour — exclusive end of the newest bucket.
  const topOfHour = new Date(now);
  topOfHour.setUTCMinutes(0, 0, 0);
  const buckets: HistogramBucket[] = [];
  for (let i = BUCKET_COUNT - 1; i >= 0; i--) {
    const bucketStart = new Date(topOfHour.getTime() - (i + 1) * bucketMs);
    const bucketEnd = new Date(bucketStart.getTime() + bucketMs);
    const startMs = bucketStart.getTime();
    const endMs = bucketEnd.getTime();
    let worst: HistogramBucket["worstStatus"] = "missing";
    for (const s of samples) {
      const t = new Date(s.sampled_at).getTime();
      if (t >= startMs && t < endMs) {
        if (STATUS_RANK[s.status] > STATUS_RANK[worst]) worst = s.status;
      }
    }
    buckets.push({
      bucketStart: bucketStart.toISOString(),
      bucketEnd: bucketEnd.toISOString(),
      worstStatus: worst,
    });
  }
  return buckets;
}
