/**
 * D1 query functions for bundle download lookup and install tracking.
 *
 * All functions accept `db: D1Database` as the first parameter (pure functions,
 * no `env` import). All timestamp writes use strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 * for ISO 8601 UTC format.
 */

// --- Bundle Lookup ---

interface VersionBundle {
  bundleKey: string;
  compressedSize: number;
  checksum: string;
}

/**
 * Look up the R2 bundle key for a published or flagged version (D-02).
 * Returns null if the version does not exist, is not in a downloadable
 * status, or the parent plugin has been revoked. The plugin-level status
 * check (via INNER JOIN) means revocation is airtight at the Worker
 * boundary — but only if the R2 bucket itself is not publicly exposed.
 * The bundle_key column contains the R2 key (pattern: plugins/{pluginId}/{version}/bundle.tgz).
 */
export async function getPublishedVersionBundle(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<VersionBundle | null> {
  const row = await db
    .prepare(
      `SELECT pv.bundle_key, pv.compressed_size, pv.checksum
       FROM plugin_versions pv
       INNER JOIN plugins p ON p.id = pv.plugin_id
       WHERE pv.plugin_id = ?
         AND pv.version = ?
         AND pv.status IN ('published', 'flagged')
         AND COALESCE(p.status, 'active') = 'active'`,
    )
    .bind(pluginId, version)
    .first<{ bundle_key: string; compressed_size: number; checksum: string }>();

  if (!row) return null;

  return {
    bundleKey: row.bundle_key,
    compressedSize: row.compressed_size,
    checksum: row.checksum,
  };
}

// --- Install Tracking ---

/**
 * Track a plugin install with dedup via INSERT OR IGNORE (D-07).
 * Uses the unique index on (plugin_id, site_hash, version) to prevent
 * duplicate tracking. Only increments plugins.installs_count when a
 * genuinely new install is recorded (D-09), checked via meta.changes.
 */
export async function trackInstall(
  db: D1Database,
  pluginId: string,
  siteHash: string,
  version: string,
): Promise<{ inserted: boolean }> {
  const id = crypto.randomUUID();
  const insertResult = await db
    .prepare(
      `INSERT OR IGNORE INTO installs (id, plugin_id, site_hash, version, created_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(id, pluginId, siteHash, version)
    .run();

  const inserted = (insertResult.meta?.changes ?? 0) > 0;

  if (inserted) {
    await db
      .prepare(
        `UPDATE plugins SET installs_count = installs_count + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`,
      )
      .bind(pluginId)
      .run();
  }

  return { inserted };
}

// --- Plugin Existence ---

/**
 * Check if a plugin exists in D1. Used by the install route to return
 * 404 for unknown plugins before attempting to track an install.
 */
export async function pluginExists(
  db: D1Database,
  pluginId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM plugins WHERE id = ?")
    .bind(pluginId)
    .first();
  return row !== null;
}

// --- Raw Download Tracking ---

/**
 * Hash a raw IP address into a per-target opaque identifier suitable
 * for the dedup tables. The salt is the target ID itself (plugin_id
 * for bundle downloads, "theme:{themeId}" for theme outbound clicks),
 * which means the same IP across two plugins produces two unrelated
 * hashes — a leaked dedup table cannot be used to correlate "this IP
 * downloaded plugin A and plugin B".
 *
 * `Web Crypto SubtleCrypto` is available natively in Workers; no
 * dependency needed. The hash is hex (64 chars) so it round-trips
 * cleanly through D1's TEXT primary key.
 */
export async function hashIpForTarget(
  ip: string,
  targetSalt: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${ip}:${targetSalt}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Lifetime-deduped increment of both the plugin-level and version-level
 * download counters. Called from the bundle endpoint after R2
 * successfully serves the artifact (so a 404 or storage miss never
 * inflates either counter).
 *
 * Dedup model: a row is recorded in `download_dedup` keyed by
 * (ip_hash, plugin_id, version). The same caller downloading the same
 * version a second time hits the unique index, INSERT OR IGNORE leaves
 * `meta.changes = 0`, and the counters are NOT bumped. The first
 * download from any given IP for any given (plugin, version) is the
 * only one that counts. This mirrors how `installs` uses `site_hash`
 * for CLI dedup.
 *
 * Pair the plugin total with `installs_count` (CLI-validated,
 * site-deduped) to compare interest (downloads) to real installs;
 * use the version-level counter to chart per-version adoption trends
 * in the admin/dashboard like a "by URL" report.
 */
export async function incrementPluginDownloads(
  db: D1Database,
  pluginId: string,
  version: string,
  ipHash: string,
): Promise<{ counted: boolean }> {
  // Step 1: claim the dedup slot. INSERT OR IGNORE returns
  // meta.changes = 0 if the (ip_hash, plugin_id, version) tuple
  // already exists, meaning this IP has downloaded this version
  // before — and we should NOT bump the counters.
  const dedup = await db
    .prepare(
      `INSERT OR IGNORE INTO download_dedup (ip_hash, plugin_id, version)
       VALUES (?, ?, ?)`,
    )
    .bind(ipHash, pluginId, version)
    .run();

  if ((dedup.meta?.changes ?? 0) === 0) {
    return { counted: false };
  }

  // Step 2: first download from this IP for this version — bump both
  // counters atomically. Batched so the plugin total and the sum of
  // version totals stay in lockstep.
  await db.batch([
    db
      .prepare(
        `UPDATE plugins
           SET downloads_count = downloads_count + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`,
      )
      .bind(pluginId),
    db
      .prepare(
        `UPDATE plugin_versions
           SET downloads_count = downloads_count + 1
         WHERE plugin_id = ? AND version = ?`,
      )
      .bind(pluginId, version),
  ]);

  return { counted: true };
}

/**
 * Lifetime-deduped increment of the theme outbound-click counter.
 * Themes are metadata-only (no bundle in our R2), so this is the
 * only "interest" signal we can capture — the user clicked through
 * to npm/repo/demo. Same dedup model as plugins: `theme_download_dedup`
 * holds (ip_hash, theme_id), and only the first click from any IP
 * for a given theme increments the counter.
 */
export async function incrementThemeDownloads(
  db: D1Database,
  themeId: string,
  ipHash: string,
): Promise<{ counted: boolean }> {
  const dedup = await db
    .prepare(
      `INSERT OR IGNORE INTO theme_download_dedup (ip_hash, theme_id)
       VALUES (?, ?)`,
    )
    .bind(ipHash, themeId)
    .run();

  if ((dedup.meta?.changes ?? 0) === 0) {
    return { counted: false };
  }

  await db
    .prepare(
      `UPDATE themes
         SET downloads_count = downloads_count + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(themeId)
    .run();

  return { counted: true };
}

/**
 * Check if a theme exists in D1. Mirrors `pluginExists` so the theme
 * tracking endpoint can return a clean 404 for unknown IDs.
 */
export async function themeExists(
  db: D1Database,
  themeId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM themes WHERE id = ?")
    .bind(themeId)
    .first();
  return row !== null;
}
