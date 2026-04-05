/**
 * Per-IP API rate limiting via D1.
 *
 * Uses per-IP-per-minute buckets stored in the rate_limits table.
 * UPSERT pattern avoids race conditions and keeps the logic to a single query.
 */

/**
 * Check and increment the rate limit counter for the given IP.
 * Returns { allowed: false } if the current minute has exceeded the threshold.
 */
export async function checkRateLimit(
  db: D1Database,
  ip: string,
  threshold: number,
): Promise<{ allowed: boolean }> {
  const minute = new Date().toISOString().slice(0, 16);
  const key = `${ip}:${minute}`;

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO rate_limits (minute, request_count)
         VALUES (?, 1)
         ON CONFLICT(minute) DO UPDATE SET request_count = request_count + 1`,
      )
      .bind(key),
    db
      .prepare("SELECT request_count FROM rate_limits WHERE minute = ?")
      .bind(key),
  ]);

  const countRow = results[1].results as { request_count: number }[];
  const count = countRow[0]?.request_count ?? 0;

  return { allowed: count <= threshold };
}
