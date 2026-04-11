/**
 * Regional best-effort badge cache purge.
 *
 * REGIONAL PURGE LIMITATION (D-15): `caches.default.delete()` only
 * affects the Cloudflare data center the Worker is currently executing
 * in. Other colos continue serving any stale entries they already hold
 * until their own `s-maxage` (1 hour per D-10) expires. This is
 * acceptable per BADG-04 — the embed badges' staleness tolerance is
 * inside the 1-hour window, and the in-app plugin detail page does not
 * flow through this cache at all.
 *
 * Global purge would require Cache Tags, which are an Enterprise-tier
 * feature — not available on the Cloudflare free tier this project is
 * constrained to. Documenting the limitation here so future readers do
 * not assume global propagation.
 *
 * All per-URL errors are swallowed (D-15): revoke / publish / trust
 * tier transition correctness MUST NEVER depend on cache plumbing
 * succeeding. The parent request finishes successfully even if every
 * delete fails.
 *
 * This helper is exported for 13-02 to wire into the six call sites
 * (audit writeback, approve, reject, revoke-version, revoke plugin,
 * restore plugin).
 */

import { BADGE_METRICS } from "./metrics";

// Re-exported so 13-02 call sites do not need a second import.
export { BADGE_METRICS } from "./metrics";

/**
 * Purge all five badge cache entries for a plugin from the edge colo
 * the Worker is currently executing in.
 *
 * @param origin - Absolute origin such as `"https://emdashcms.org"`.
 *   Callers typically pass `new URL(request.url).origin` at request
 *   time; background consumers (the audit queue) pass a configured
 *   `SITE_ORIGIN` env var or the hardcoded production origin.
 * @param pluginId - Raw plugin id. Scoped ids such as `@scope/name`
 *   are URL-encoded internally so the cache keys match what the
 *   embed snippets produce.
 */
export async function purgeBadges(
  origin: string,
  pluginId: string,
): Promise<void> {
  const cache = caches.default;
  const encodedId = encodeURIComponent(pluginId);
  for (const metric of BADGE_METRICS) {
    const url = `${origin}/badges/v1/plugin/${encodedId}/${metric}.svg`;
    try {
      await cache.delete(url);
    } catch (err) {
      console.error(`[badges] purge failed url=${url}:`, err);
    }
  }
}
