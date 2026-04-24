import { mostRecentCompletedWeek } from "./week-boundary";
import {
  computeWeeklySnapshot,
  upsertTransparencyWeek,
} from "./transparency-queries";

/**
 * Called by the Sunday 00:10 UTC cron (see src/worker.ts dispatch).
 *
 * Computes aggregates for the most recently completed week and upserts
 * one transparency_weeks row. NEVER throws — any failure is logged via
 * console.error so the scheduled() handler returns cleanly and the next
 * cron tick is unaffected (Phase 15 D-28).
 */
export async function runWeeklyTransparency(env: Env): Promise<void> {
  try {
    const isoWeek = mostRecentCompletedWeek(new Date());
    console.log(`[transparency] computing snapshot for ${isoWeek}`);
    const snapshot = await computeWeeklySnapshot(env.DB, isoWeek);
    await upsertTransparencyWeek(env.DB, snapshot);
    console.log(`[transparency] snapshot for ${isoWeek} written`);
  } catch (err) {
    console.error("[transparency] runWeeklyTransparency failed:", err);
  }
}
