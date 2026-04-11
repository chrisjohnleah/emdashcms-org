// Phase 14: Row -> FeedEntry mappers. Implemented in Task 3.
import type { FeedEntry } from "./atom-builder";
import type {
  FeedPluginRow,
  FeedPluginVersionRow,
  FeedThemeRow,
} from "./feed-queries";

export interface PluginFeedContext {
  kind: "new";
  category?: string;
}

export function pluginsToFeedEntries(
  _rows: FeedPluginRow[],
  _ctx: PluginFeedContext,
): FeedEntry[] {
  throw new Error("not implemented (Task 3)");
}
export function pluginVersionsToFeedEntries(
  _rows: FeedPluginVersionRow[],
): FeedEntry[] {
  throw new Error("not implemented (Task 3)");
}
export function themesToFeedEntries(_rows: FeedThemeRow[]): FeedEntry[] {
  throw new Error("not implemented (Task 3)");
}
