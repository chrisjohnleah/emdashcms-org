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
