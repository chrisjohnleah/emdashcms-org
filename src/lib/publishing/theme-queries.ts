/**
 * D1 query functions for theme registration, listing, ownership verification,
 * and metadata updates.
 *
 * All functions accept `db: D1Database` as the first parameter (pure functions,
 * no `env` import). All timestamp writes use strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 * for ISO 8601 UTC format (D-25).
 */

// --- Interfaces ---

export interface ThemeRegistrationInput {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  preview_url?: string;
  demo_url?: string;
  repository_url?: string;
  homepage_url?: string;
  license?: string;
}

export interface DashboardTheme {
  id: string;
  name: string;
  keywords: string[];
  license: string | null;
  updatedAt: string;
}

export interface UpdateThemeMetadataInput {
  description?: string;
  keywords?: string[];
  previewUrl?: string;
  demoUrl?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  license?: string;
}

// --- Theme Registration ---

/**
 * Register a new theme in D1 with the given metadata.
 * Keywords are stored as a JSON array.
 */
export async function registerTheme(
  db: D1Database,
  authorId: string,
  data: ThemeRegistrationInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO themes (
        id, author_id, name, description, keywords,
        preview_url, demo_url, repository_url, homepage_url, license,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      )`,
    )
    .bind(
      data.id,
      authorId,
      data.name,
      data.description,
      JSON.stringify(data.keywords ?? []),
      data.preview_url ?? null,
      data.demo_url ?? null,
      data.repository_url ?? null,
      data.homepage_url ?? null,
      data.license ?? null,
    )
    .run();
}

// --- Dashboard Listing ---

/**
 * Get all themes for an author, ordered by updated_at DESC.
 */
export async function getThemesByAuthor(
  db: D1Database,
  authorId: string,
): Promise<DashboardTheme[]> {
  const result = await db
    .prepare(
      `SELECT id, name, keywords, license, updated_at
       FROM themes
       WHERE author_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(authorId)
    .all();

  return (result.results as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    keywords: JSON.parse((row.keywords as string) || "[]"),
    license: (row.license as string) ?? null,
    updatedAt: row.updated_at as string,
  }));
}

// --- Ownership ---

/**
 * Get the owner (author_id) of a theme. Returns null if the theme does not exist.
 */
export async function getThemeOwner(
  db: D1Database,
  themeId: string,
): Promise<{ authorId: string } | null> {
  const row = await db
    .prepare("SELECT author_id FROM themes WHERE id = ?")
    .bind(themeId)
    .first<{ author_id: string }>();
  return row ? { authorId: row.author_id } : null;
}

// --- Metadata Update ---

/**
 * Update editable metadata fields on a theme.
 * Only fields explicitly provided (not undefined) are updated.
 * Always bumps updated_at to the current UTC timestamp.
 */
export async function updateThemeMetadata(
  db: D1Database,
  themeId: string,
  data: UpdateThemeMetadataInput,
): Promise<void> {
  const fields: { col: string; val: unknown }[] = [];

  if (data.description !== undefined)
    fields.push({ col: "description", val: data.description });
  if (data.keywords !== undefined)
    fields.push({ col: "keywords", val: JSON.stringify(data.keywords) });
  if (data.previewUrl !== undefined)
    fields.push({ col: "preview_url", val: data.previewUrl });
  if (data.demoUrl !== undefined)
    fields.push({ col: "demo_url", val: data.demoUrl });
  if (data.repositoryUrl !== undefined)
    fields.push({ col: "repository_url", val: data.repositoryUrl });
  if (data.homepageUrl !== undefined)
    fields.push({ col: "homepage_url", val: data.homepageUrl });
  if (data.license !== undefined)
    fields.push({ col: "license", val: data.license });

  if (fields.length === 0) return;

  const setClauses = fields.map((f) => `${f.col} = ?`);
  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");

  const sql = `UPDATE themes SET ${setClauses.join(", ")} WHERE id = ?`;
  const params = [...fields.map((f) => f.val), themeId];

  await db
    .prepare(sql)
    .bind(...params)
    .run();
}

// --- Image Key Updates ---

/**
 * Set or clear the thumbnail R2 key for a theme.
 */
export async function updateThemeThumbnailKey(
  db: D1Database,
  themeId: string,
  key: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE themes SET thumbnail_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    )
    .bind(key, themeId)
    .run();
}

/**
 * Set the screenshot R2 keys (JSON array) for a theme.
 */
export async function updateThemeScreenshotKeys(
  db: D1Database,
  themeId: string,
  keys: string[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE themes SET screenshot_keys = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    )
    .bind(JSON.stringify(keys), themeId)
    .run();
}
