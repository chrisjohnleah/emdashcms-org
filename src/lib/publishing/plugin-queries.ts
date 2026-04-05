/**
 * D1 query functions for plugin registration, version creation, rate limiting,
 * ownership verification, and audit retry management.
 *
 * All functions accept `db: D1Database` as the first parameter (pure functions,
 * no `env` import). All timestamp writes use strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 * for ISO 8601 UTC format (D-25).
 */

// --- Interfaces ---

export interface PluginRegistrationInput {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  keywords?: string[];
  license?: string;
  category?: string;
  repository_url?: string;
  homepage_url?: string;
  support_url?: string;
  funding_url?: string;
}

export interface CreateVersionInput {
  pluginId: string;
  version: string;
  manifest: string;
  bundleKey: string;
  checksum: string;
  fileCount: number;
  compressedSize: number;
  decompressedSize: number;
  changelog?: string;
  minEmDashVersion?: string;
  source?: "upload" | "github";
}

// --- Author ID Resolution ---

/**
 * Resolve a GitHub user ID to the internal author UUID.
 * The JWT `sub` claim contains the GitHub ID (number), but all D1 tables
 * reference the internal UUID from authors.id.
 */
export async function resolveAuthorId(
  db: D1Database,
  githubId: number,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM authors WHERE github_id = ?")
    .bind(githubId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// --- Plugin Registration ---

/**
 * Register a new plugin in D1 with the given metadata.
 * capabilities and keywords are stored as JSON arrays.
 */
export async function registerPlugin(
  db: D1Database,
  authorId: string,
  data: PluginRegistrationInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugins (
        id, author_id, name, description, capabilities, keywords,
        license, category, repository_url, homepage_url, support_url, funding_url,
        installs_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      )`,
    )
    .bind(
      data.id,
      authorId,
      data.name,
      data.description,
      JSON.stringify(data.capabilities),
      JSON.stringify(data.keywords ?? []),
      data.license ?? null,
      data.category ?? null,
      data.repository_url ?? null,
      data.homepage_url ?? null,
      data.support_url ?? null,
      data.funding_url ?? null,
    )
    .run();
}

// --- Ownership ---

/**
 * Get the owner (author_id) of a plugin. Returns null if the plugin does not exist.
 */
export async function getPluginOwner(
  db: D1Database,
  pluginId: string,
): Promise<{ authorId: string } | null> {
  const row = await db
    .prepare("SELECT author_id FROM plugins WHERE id = ?")
    .bind(pluginId)
    .first<{ author_id: string }>();
  return row ? { authorId: row.author_id } : null;
}

// --- Metadata Update ---

export interface UpdatePluginMetadataInput {
  description?: string;
  keywords?: string[];
  repositoryUrl?: string;
  homepageUrl?: string;
  supportUrl?: string;
  fundingUrl?: string;
  license?: string;
}

/**
 * Update editable metadata fields on a plugin.
 * Only fields explicitly provided (not undefined) are updated.
 * Always bumps updated_at to the current UTC timestamp.
 */
export async function updatePluginMetadata(
  db: D1Database,
  pluginId: string,
  data: UpdatePluginMetadataInput,
): Promise<void> {
  const fields: { col: string; val: unknown }[] = [];

  if (data.description !== undefined)
    fields.push({ col: "description", val: data.description });
  if (data.keywords !== undefined)
    fields.push({ col: "keywords", val: JSON.stringify(data.keywords) });
  if (data.repositoryUrl !== undefined)
    fields.push({ col: "repository_url", val: data.repositoryUrl });
  if (data.homepageUrl !== undefined)
    fields.push({ col: "homepage_url", val: data.homepageUrl });
  if (data.supportUrl !== undefined)
    fields.push({ col: "support_url", val: data.supportUrl });
  if (data.fundingUrl !== undefined)
    fields.push({ col: "funding_url", val: data.fundingUrl });
  if (data.license !== undefined)
    fields.push({ col: "license", val: data.license });

  if (fields.length === 0) return;

  const setClauses = fields.map((f) => `${f.col} = ?`);
  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");

  const sql = `UPDATE plugins SET ${setClauses.join(", ")} WHERE id = ?`;
  const params = [...fields.map((f) => f.val), pluginId];

  await db
    .prepare(sql)
    .bind(...params)
    .run();
}

// --- Rate Limiting ---

/**
 * Check whether an author has exceeded the daily upload rate limit (5 per UTC day).
 * Only counts successful uploads (version records that exist in D1).
 * Per D-19, failed validation does not consume a rate limit slot.
 */
export async function checkUploadRateLimit(
  db: D1Database,
  authorId: string,
): Promise<{ allowed: boolean; retryAfter?: string }> {
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) as count FROM plugin_versions
       WHERE plugin_id IN (SELECT id FROM plugins WHERE author_id = ?)
       AND created_at >= strftime('%Y-%m-%dT00:00:00Z', 'now')`,
    )
    .bind(authorId)
    .first<{ count: number }>();

  const count = countRow?.count ?? 0;

  if (count >= 5) {
    const retryRow = await db
      .prepare(
        "SELECT strftime('%Y-%m-%dT00:00:00Z', date('now', '+1 day')) as retry_after",
      )
      .first<{ retry_after: string }>();

    return { allowed: false, retryAfter: retryRow?.retry_after };
  }

  return { allowed: true };
}

// --- Version Existence ---

/**
 * Check if a specific version already exists for a plugin.
 * Used to return 409 Conflict instead of a UNIQUE constraint error.
 */
export async function checkVersionExists(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 as exists_flag FROM plugin_versions WHERE plugin_id = ? AND version = ?",
    )
    .bind(pluginId, version)
    .first();
  return row !== null;
}

// --- Version Creation ---

/**
 * Create a new pending version record in D1.
 * Returns the generated version UUID.
 */
export async function createVersion(
  db: D1Database,
  input: CreateVersionInput,
): Promise<string> {
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO plugin_versions (
        id, plugin_id, version, status, bundle_key, manifest,
        file_count, compressed_size, decompressed_size, min_emdash_version,
        checksum, changelog, screenshots, retry_count, source,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'pending', ?, ?,
        ?, ?, ?, ?,
        ?, ?, '[]', 0, ?,
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      )`,
    )
    .bind(
      id,
      input.pluginId,
      input.version,
      input.bundleKey,
      input.manifest,
      input.fileCount,
      input.compressedSize,
      input.decompressedSize,
      input.minEmDashVersion ?? null,
      input.checksum,
      input.changelog ?? null,
      input.source ?? "upload",
    )
    .run();

  return id;
}

// --- Retry Support ---

/**
 * Get a version record for retry-audit evaluation.
 * Returns the version's id, bundle key, retry count, and status.
 */
export async function getVersionForRetry(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<{
  id: string;
  bundleKey: string;
  retryCount: number;
  status: string;
} | null> {
  const row = await db
    .prepare(
      "SELECT id, bundle_key, retry_count, status FROM plugin_versions WHERE plugin_id = ? AND version = ?",
    )
    .bind(pluginId, version)
    .first<{
      id: string;
      bundle_key: string;
      retry_count: number;
      status: string;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    bundleKey: row.bundle_key,
    retryCount: row.retry_count,
    status: row.status,
  };
}

/**
 * Increment retry count and reset status to pending for a version.
 * Called when a publisher retries a rejected audit.
 */
export async function incrementRetryCount(
  db: D1Database,
  versionId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugin_versions
       SET retry_count = retry_count + 1,
           status = 'pending',
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(versionId)
    .run();
}
