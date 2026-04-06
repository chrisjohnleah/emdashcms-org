/**
 * Per-IP API rate limiting via D1.
 *
 * Uses per-IP-per-minute buckets stored in the rate_limits table.
 * Single-statement INSERT...RETURNING avoids the cost of two D1 ops per check.
 */

/**
 * Check and increment the rate limit counter for the given IP.
 * Returns { allowed: false } if the current minute has exceeded the threshold.
 *
 * Uses a single INSERT...RETURNING statement to halve D1 operations per check.
 */
export async function checkRateLimit(
  db: D1Database,
  ip: string,
  threshold: number,
): Promise<{ allowed: boolean }> {
  const minute = new Date().toISOString().slice(0, 16);
  const key = `${ip}:${minute}`;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (minute, request_count)
       VALUES (?, 1)
       ON CONFLICT(minute) DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`,
    )
    .bind(key)
    .first<{ request_count: number }>();

  const count = row?.request_count ?? 0;
  return { allowed: count <= threshold };
}

/**
 * Delete rate_limit rows older than the cutoff.
 * Called from the scheduled handler in worker.ts.
 *
 * The minute key is `{ip}:{YYYY-MM-DDTHH:MM}`. Since the timestamp is
 * always exactly 16 chars at the end, we can extract it with SUBSTR.
 */
export async function cleanupOldRateLimits(
  db: D1Database,
  cutoffMinute: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM rate_limits WHERE SUBSTR(minute, -16) < ?")
    .bind(cutoffMinute)
    .run();
}
