/**
 * D1 query layer for plugin deprecation and unlist self-service.
 *
 * Functions accept `db: D1Database` first and never import `env` — they
 * follow the pure-function pattern established by plugin-queries.ts.
 * Timestamps use strftime('%Y-%m-%dT%H:%M:%SZ', 'now') for ISO 8601 UTC.
 *
 * Access control is explicitly OUT OF SCOPE for this module. Permissions
 * live on the route layer (checkPluginAccess from Phase 11). Every
 * function here assumes the caller has already verified owner-or-
 * maintainer authority over the target plugin (T-17-05 disposition).
 */

// --- Types ---

export type DeprecationCategory =
  | "unmaintained"
  | "replaced"
  | "abandoned"
  | "security"
  | "other";

const VALID_CATEGORIES: ReadonlySet<string> = new Set<DeprecationCategory>([
  "unmaintained",
  "replaced",
  "abandoned",
  "security",
  "other",
]);

/**
 * Human-readable fallback rendered by the CLI / install banner when the
 * plugin author did not supply a free-text note. Keep these short and
 * consumer-facing — they appear verbatim under "Deprecation warning:"
 * in the EmDash CLI output.
 */
const CATEGORY_FALLBACK_LABEL: Record<DeprecationCategory, string> = {
  unmaintained: "no longer maintained",
  replaced: "has been replaced",
  abandoned: "abandoned by its author",
  security: "withdrawn for security reasons",
  other: "deprecated",
};

const MAX_NOTE_LENGTH = 500;
/** Safety rail on successor-chain walk — see detectSuccessorCycle. */
const MAX_SUCCESSOR_DEPTH = 10;

export interface DeprecatePluginInput {
  pluginId: string;
  actorAuthorId: string;
  category: DeprecationCategory;
  /** Trimmed server-side; null / empty / whitespace stored as NULL. */
  note?: string | null;
  /** Null or omitted to clear; otherwise must pass successor validation. */
  successorId?: string | null;
}

export type DeprecatePluginError =
  | "invalid_category"
  | "note_too_long"
  | "successor_self"
  | "successor_deprecated"
  | "successor_unlisted"
  | "successor_not_found"
  | "successor_cycle";

export type DeprecatePluginResult =
  | { ok: true }
  | { ok: false; error: DeprecatePluginError };

/**
 * Wire shape returned by the install-tracking endpoint and consumed by
 * the EmDash CLI. Stable public contract — additive changes only.
 */
export interface DeprecationWarningWire {
  reason: string;
  category: DeprecationCategory;
  successor?: { id: string; name: string; url: string };
}

export interface SuccessorCandidate {
  id: string;
  name: string;
  authorUsername: string;
}

// --- Helpers ---

function normaliseNote(note: string | null | undefined): {
  value: string | null;
  tooLong: boolean;
} {
  if (note === undefined || note === null) return { value: null, tooLong: false };
  const trimmed = note.trim();
  if (trimmed.length === 0) return { value: null, tooLong: false };
  if (trimmed.length > MAX_NOTE_LENGTH) return { value: null, tooLong: true };
  return { value: trimmed, tooLong: false };
}

/**
 * Iterative successor-chain walk with a visited set and fixed depth cap.
 *
 * Semantics: given a proposed edge fromPluginId -> toPluginId, returns
 * true if following toPluginId's existing successor chain eventually
 * reaches fromPluginId (cycle) OR if the chain is longer than
 * MAX_SUCCESSOR_DEPTH hops (treated as a cycle as a safety rail to bound
 * D1 reads and prevent adversarially-constructed deep chains per T-17-02).
 */
export async function detectSuccessorCycle(
  db: D1Database,
  fromPluginId: string,
  toPluginId: string,
): Promise<boolean> {
  if (fromPluginId === toPluginId) return true;

  const visited = new Set<string>();
  let current: string | null = toPluginId;
  let depth = 0;

  while (current !== null) {
    if (depth >= MAX_SUCCESSOR_DEPTH) return true; // safety rail
    if (visited.has(current)) return true; // existing cycle downstream
    visited.add(current);
    if (current === fromPluginId) return true; // would close a cycle

    const row: { successor_id: string | null } | null = await db
      .prepare("SELECT successor_id FROM plugins WHERE id = ?")
      .bind(current)
      .first<{ successor_id: string | null }>();

    if (!row) return false; // chain hit a non-existent plugin — no cycle
    current = row.successor_id;
    depth += 1;
  }

  return false;
}

// --- Successor candidate lookup (typeahead) ---

/**
 * Candidate plugins the UI can suggest as a successor on the deprecate
 * form. Filters to non-deprecated + non-unlisted + non-self + published.
 * The same filter is re-enforced at write-time by deprecatePlugin so a
 * stale client cannot slip a poisoned id through (T-17-01).
 */
export async function searchSuccessorCandidates(
  db: D1Database,
  query: string,
  selfPluginId: string,
  limit = 10,
): Promise<SuccessorCandidate[]> {
  const pattern = `%${query}%`;
  const result = await db
    .prepare(
      `SELECT p.id, p.name, a.github_username
       FROM plugins p
       JOIN authors a ON a.id = p.author_id
       WHERE p.id != ?
         AND p.deprecated_at IS NULL
         AND p.unlisted_at IS NULL
         AND (p.name LIKE ? COLLATE NOCASE OR p.id LIKE ? COLLATE NOCASE)
         AND EXISTS (
           SELECT 1 FROM plugin_versions pv
           WHERE pv.plugin_id = p.id
             AND pv.status IN ('published', 'flagged')
         )
       ORDER BY p.installs_count DESC, p.name COLLATE NOCASE ASC
       LIMIT ?`,
    )
    .bind(selfPluginId, pattern, pattern, limit)
    .all<{ id: string; name: string; github_username: string }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    authorUsername: row.github_username,
  }));
}

// --- Mutation: deprecate / undeprecate / unlist / relist ---

export async function deprecatePlugin(
  db: D1Database,
  input: DeprecatePluginInput,
): Promise<DeprecatePluginResult> {
  if (!VALID_CATEGORIES.has(input.category)) {
    return { ok: false, error: "invalid_category" };
  }

  const { value: noteValue, tooLong } = normaliseNote(input.note ?? null);
  if (tooLong) return { ok: false, error: "note_too_long" };

  let successorIdToWrite: string | null = null;
  if (input.successorId) {
    if (input.successorId === input.pluginId) {
      return { ok: false, error: "successor_self" };
    }

    const successor = await db
      .prepare(
        `SELECT id, deprecated_at, unlisted_at
         FROM plugins WHERE id = ?`,
      )
      .bind(input.successorId)
      .first<{
        id: string;
        deprecated_at: string | null;
        unlisted_at: string | null;
      }>();

    if (!successor) return { ok: false, error: "successor_not_found" };
    if (successor.deprecated_at !== null) {
      return { ok: false, error: "successor_deprecated" };
    }
    if (successor.unlisted_at !== null) {
      return { ok: false, error: "successor_unlisted" };
    }

    const cycle = await detectSuccessorCycle(
      db,
      input.pluginId,
      input.successorId,
    );
    if (cycle) return { ok: false, error: "successor_cycle" };

    successorIdToWrite = input.successorId;
  }

  await db
    .prepare(
      `UPDATE plugins
         SET deprecated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             deprecated_by = ?,
             deprecated_reason_category = ?,
             deprecated_reason_note = ?,
             successor_id = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(
      input.actorAuthorId,
      input.category,
      noteValue,
      successorIdToWrite,
      input.pluginId,
    )
    .run();

  return { ok: true };
}

/**
 * Atomically clear every deprecation field and bump updated_at.
 * Idempotent — calling on an already-active plugin is a no-op write.
 * actorAuthorId is accepted for symmetry with deprecatePlugin even
 * though it isn't persisted on the undeprecate path (no "undeprecated_by"
 * column by design — the audit trail is the inline deprecated_by and
 * the updated_at bump).
 */
export async function undeprecatePlugin(
  db: D1Database,
  pluginId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actorAuthorId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugins
         SET deprecated_at = NULL,
             deprecated_by = NULL,
             deprecated_reason_category = NULL,
             deprecated_reason_note = NULL,
             successor_id = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(pluginId)
    .run();
}

export async function unlistPlugin(
  db: D1Database,
  pluginId: string,
  actorAuthorId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugins
         SET unlisted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             unlisted_by = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(actorAuthorId, pluginId)
    .run();
}

export async function relistPlugin(
  db: D1Database,
  pluginId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE plugins
         SET unlisted_at = NULL,
             unlisted_by = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
    .bind(pluginId)
    .run();
}

// --- Read: install-time warning payload ---

/**
 * Resolve the wire payload the install endpoint returns for a deprecated
 * plugin. Returns null when the plugin is not deprecated so callers can
 * emit an empty-body 202 on the hot path.
 *
 * Defensive broken-chain handling (T-17-08): if the stored successor is
 * itself deprecated OR unlisted OR no longer present, we drop the
 * successor field rather than expose a dead link to consumers.
 */
export async function getDeprecationWarning(
  db: D1Database,
  pluginId: string,
): Promise<DeprecationWarningWire | null> {
  const row = await db
    .prepare(
      `SELECT p.deprecated_at,
              p.deprecated_reason_category,
              p.deprecated_reason_note,
              p.successor_id,
              s.id AS successor_plugin_id,
              s.name AS successor_name,
              s.deprecated_at AS successor_deprecated_at,
              s.unlisted_at AS successor_unlisted_at
       FROM plugins p
       LEFT JOIN plugins s ON s.id = p.successor_id
       WHERE p.id = ?`,
    )
    .bind(pluginId)
    .first<{
      deprecated_at: string | null;
      deprecated_reason_category: DeprecationCategory | null;
      deprecated_reason_note: string | null;
      successor_id: string | null;
      successor_plugin_id: string | null;
      successor_name: string | null;
      successor_deprecated_at: string | null;
      successor_unlisted_at: string | null;
    }>();

  if (!row || row.deprecated_at === null) return null;

  const category: DeprecationCategory =
    (row.deprecated_reason_category as DeprecationCategory | null) ?? "other";
  const noteTrimmed = row.deprecated_reason_note?.trim() ?? "";
  const reason =
    noteTrimmed.length > 0
      ? noteTrimmed
      : CATEGORY_FALLBACK_LABEL[category];

  const successorChainLive =
    row.successor_plugin_id !== null &&
    row.successor_name !== null &&
    row.successor_deprecated_at === null &&
    row.successor_unlisted_at === null;

  const wire: DeprecationWarningWire = { reason, category };
  if (successorChainLive) {
    wire.successor = {
      id: row.successor_plugin_id as string,
      name: row.successor_name as string,
      url: `/plugins/${row.successor_plugin_id}`,
    };
  }
  return wire;
}
