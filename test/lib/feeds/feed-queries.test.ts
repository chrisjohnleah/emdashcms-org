import { describe, it } from "vitest";
// Coverage for 14-CONTEXT.md D-08/D-09/D-10/D-11 + 14-RESEARCH.md §6.
describe("listRecentPluginsForFeed", () => {
  it.todo("returns up to limit rows sorted by created_at DESC");
  it.todo(
    "excludes plugins with only pending/rejected/revoked versions (active-plugin filter)",
  );
  it.todo("includes plugins with at least one published OR flagged version");
  it.todo("joins authors and returns authorLogin column");
});
describe("listRecentPluginVersionsForFeed", () => {
  it.todo("emits one row per published/flagged version (5 versions = 5 rows)");
  it.todo(
    "sorts by COALESCE(published_at, created_at) DESC (not pv.published_at alone)",
  );
  it.todo("excludes status=pending rows");
  it.todo("excludes status=rejected rows");
  it.todo("excludes status=revoked rows");
});
describe("listRecentThemesForFeed", () => {
  it.todo(
    "applies the active-theme filter (repository_url IS NOT NULL OR npm_package IS NOT NULL)",
  );
  it.todo("sorts by created_at DESC");
});
describe("listPluginsByCategoryForFeed", () => {
  it.todo("filters rows to the requested category (WHERE p.category = ?)");
  it.todo("applies the same active-plugin filter as listRecentPluginsForFeed");
  it.todo("returns empty array for a known-but-empty category");
});
