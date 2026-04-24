/**
 * Status probe cron orchestrator — runs every 5 minutes (15-CONTEXT D-21).
 *
 * Pipeline per tick:
 *   1. Retention DELETE (cutoff = now − 7 days).
 *   2. Sequential probe of each surface that has a buildable URL.
 *      Surfaces requiring the canary plugin id/version are skipped
 *      with a console.warn when the env vars are unset.
 *   3. Insert one status_samples row per probe.
 *
 * Every step is wrapped in a try/catch — D-28 forbids ANY uncaught
 * throw out of scheduled() because that poisons the cron tick. A
 * failed probe still inserts a `fail`/`timeout` row via probeSurface
 * itself; the per-surface try/catch is a defensive backstop for any
 * unexpected error around the insert path.
 */

import { ALL_SURFACES, probeSurface, type Surface } from "./probe";
import { enforceRetention, insertSample } from "./status-queries";

const BASE_URL = "https://emdashcms.org";

function buildUrl(
  surface: Surface,
  canaryId: string,
  canaryVersion: string,
): string | null {
  if (surface.requiresCanary && (!canaryId || !canaryVersion)) return null;
  const path = surface.pathTemplate
    .replace("{canaryId}", canaryId)
    .replace("{canaryVersion}", canaryVersion);
  return `${BASE_URL}${path}`;
}

export async function runStatusProbes(env: Env): Promise<void> {
  try {
    // 1) Retention cleanup (wrapped — D-28).
    try {
      const cutoff = new Date(
        Date.now() - 7 * 24 * 60 * 60_000,
      ).toISOString();
      await enforceRetention(env.DB, cutoff);
    } catch (err) {
      console.error("[status] retention cleanup failed:", err);
    }

    const canaryId = env.SURFACE_CANARY_PLUGIN_ID ?? "";
    const canaryVersion = env.SURFACE_CANARY_VERSION ?? "";

    // 2) Sequential probes (D-23). Each probe is wrapped per D-28.
    for (const surface of ALL_SURFACES) {
      const url = buildUrl(surface, canaryId, canaryVersion);
      if (url === null) {
        console.warn(
          `[status] canary not configured — skipping ${surface.name} probe`,
        );
        continue;
      }
      try {
        const sample = await probeSurface(fetch, surface, url);
        await insertSample(env.DB, sample);
      } catch (err) {
        console.error(
          `[status] probe ${surface.name} unexpected error:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error("[status] runStatusProbes unexpected outer error:", err);
  }
}
