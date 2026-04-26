/**
 * Cheap normalized similarity for catching the lazy-rename pattern at
 * registration — e.g. an author with `smtp-email-provider` trying to
 * register `email-provider` with the same bundle content. The checksum
 * dedup at `findChecksumCollision` catches byte-identical reuploads;
 * this catches the case where a determined author tweaked the bundle
 * slightly but kept the slug nearly identical.
 *
 * Implementation is plain Levenshtein with a normalize step (lowercase,
 * strip non-alphanumeric). Threshold is intentionally a soft warning,
 * not a hard block — the form requires an explicit acknowledgment to
 * proceed, which both nudges legitimate forks and creates a paper
 * trail for moderation.
 */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Split on common slug separators to get the conceptual tokens.
 * Filters out tokens shorter than 2 chars to avoid false positives
 * from `a-b-c`-style noise.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Returns true if one token set is a non-empty subset of the other,
 * with at least 2 tokens shared. Catches the lazy-rename pattern
 * (`smtp-email-provider` vs `email-provider`) that pure Levenshtein
 * scores below the 0.8 threshold despite being clearly the same
 * concept with a prefix added or removed.
 */
function isTokenSubset(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return false;
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (smaller.size < 2) return false;
  for (const t of smaller) {
    if (!larger.has(t)) return false;
  }
  return true;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Single-row DP — O(min(a,b)) memory.
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = a[i - 1] === b[j - 1]
        ? prevDiag
        : 1 + Math.min(prev[j], prev[j - 1], prevDiag);
      prevDiag = temp;
    }
  }
  return prev[b.length];
}

/**
 * Returns a similarity ratio in [0, 1]. 1.0 = identical after
 * normalization, OR one's hyphen-tokens are a subset of the other's
 * (≥ 2 shared tokens) — this token shortcut catches the lazy-rename
 * pattern that pure Levenshtein scores too low. Returns 0 for
 * either side empty.
 */
export function similarityRatio(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (isTokenSubset(a, b)) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

export interface SimilarityCandidate {
  id: string;
  name: string;
}

export interface SimilarityMatch {
  candidate: SimilarityCandidate;
  ratio: number;
  matchedField: "id" | "name";
}

/**
 * Find the closest match among candidates for a proposed plugin
 * id+name. Returns the highest-scoring match above the threshold, or
 * null. Compares against both the candidate id and name so an author
 * can't bypass the warning by tweaking only one field.
 */
export function findSimilarPlugin(
  proposed: { id: string; name: string },
  candidates: SimilarityCandidate[],
  threshold = 0.8,
): SimilarityMatch | null {
  let best: SimilarityMatch | null = null;
  for (const c of candidates) {
    const idRatio = similarityRatio(proposed.id, c.id);
    const nameRatio = similarityRatio(proposed.name, c.name);
    const better = idRatio >= nameRatio
      ? { ratio: idRatio, matchedField: "id" as const }
      : { ratio: nameRatio, matchedField: "name" as const };
    if (better.ratio >= threshold && (!best || better.ratio > best.ratio)) {
      best = { candidate: c, ratio: better.ratio, matchedField: better.matchedField };
    }
  }
  return best;
}
