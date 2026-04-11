// Phase 14: Weekly digest snapshot + cron entrypoint. See 14-CONTEXT.md
// D-19..D-28 and 14-RESEARCH.md §8. Implemented in Task 2.
import type { IsoWeek } from "./iso-week";

export interface WeeklyDigestManifest {
  version: 1;
  isoWeek: string;
  windowStartUtc: string;
  windowEndUtc: string;
  newPlugins: Array<{
    id: string;
    name: string;
    category: string | null;
    shortDescription: string | null;
    authorLogin: string;
    createdAt: string;
  }>;
  updatedPlugins: Array<{
    pluginId: string;
    name: string;
    version: string;
    authorLogin: string;
    publishedAt: string;
  }>;
  newThemes: Array<{
    id: string;
    name: string;
    shortDescription: string | null;
    authorLogin: string;
    createdAt: string;
  }>;
  counts: {
    newPlugins: number;
    updatedPlugins: number;
    newThemes: number;
  };
}

export async function snapshotWeek(
  _db: D1Database,
  _week: IsoWeek,
): Promise<WeeklyDigestManifest> {
  throw new Error("not implemented (Task 2)");
}

export async function runWeeklyDigest(
  _env: { DB: D1Database },
  _now?: Date,
): Promise<void> {
  throw new Error("not implemented (Task 2)");
}
