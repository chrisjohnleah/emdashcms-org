/**
 * Global API rate limiting via D1.
 *
 * Uses per-minute buckets stored in the rate_limits table (D-13).
 * Threshold: 60 requests per UTC minute (D-14).
 * UPSERT pattern avoids race conditions and keeps the logic to a single query.
 */

const RATE_LIMIT_THRESHOLD = 60;

/**
 * Check and increment the global rate limit counter.
 * Returns { allowed: false } if the current minute has exceeded 60 requests.
 *
 * Implementation: UPSERT into rate_limits, then read back the count.
 * Two statements are batched for efficiency.
 */
export async function checkRateLimit(
  db: D1Database,
): Promise<{ allowed: boolean }> {
  const minute = new Date().toISOString().slice(0, 16);

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO rate_limits (minute, request_count)
         VALUES (?, 1)
         ON CONFLICT(minute) DO UPDATE SET request_count = request_count + 1`,
      )
      .bind(minute),
    db
      .prepare("SELECT request_count FROM rate_limits WHERE minute = ?")
      .bind(minute),
  ]);

  const countRow = results[1].results as { request_count: number }[];
  const count = countRow[0]?.request_count ?? 0;

  return { allowed: count <= RATE_LIMIT_THRESHOLD };
}
