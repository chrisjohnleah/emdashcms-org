// Phase 14: D1 query helpers for feeds. Implemented in Task 3.
// Pure functions — db is the first parameter, no env import.
export interface FeedPluginRow {
  id: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  category: string | null;
  createdAt: string;
  authorLogin: string;
}
export interface FeedPluginVersionRow {
  pluginId: string;
  name: string;
  version: string;
  shortDescription: string | null;
  description: string | null;
  category: string | null;
  publishedAt: string;
  authorLogin: string;
}
export interface FeedThemeRow {
  id: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  createdAt: string;
  authorLogin: string;
}
export async function listRecentPluginsForFeed(
  _db: D1Database,
  _limit: number,
): Promise<FeedPluginRow[]> {
  throw new Error("not implemented (Task 3)");
}
export async function listRecentPluginVersionsForFeed(
  _db: D1Database,
  _limit: number,
): Promise<FeedPluginVersionRow[]> {
  throw new Error("not implemented (Task 3)");
}
export async function listRecentThemesForFeed(
  _db: D1Database,
  _limit: number,
): Promise<FeedThemeRow[]> {
  throw new Error("not implemented (Task 3)");
}
export async function listPluginsByCategoryForFeed(
  _db: D1Database,
  _category: string,
  _limit: number,
): Promise<FeedPluginRow[]> {
  throw new Error("not implemented (Task 3)");
}
