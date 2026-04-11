import { describe, it } from "vitest";
// Coverage for 14-CONTEXT.md D-11/D-12/D-13 + T-14-02 (category injection).
describe("/feeds/plugins/new.xml handler", () => {
  it.todo("returns 200 with content-type application/atom+xml; charset=utf-8");
  it.todo(
    "emits Cache-Control: public, max-age=600, s-maxage=600, stale-while-revalidate=3600",
  );
  it.todo("contains tag:emdashcms.org,2026:feed:plugins:new as the feed id");
  it.todo("contains one <entry> per seeded active plugin, ordered by created_at DESC");
  it.todo("caps entries at 50 when more than 50 active plugins exist");
});
describe("/feeds/plugins/updated.xml handler", () => {
  it.todo("emits one entry per published/flagged plugin_version");
  it.todo('entry title is "{plugin_name} v{version}"');
  it.todo("excludes pending/rejected/revoked versions");
});
describe("/feeds/themes/new.xml handler", () => {
  it.todo("applies active-theme filter");
  it.todo("returns 200 Atom 1.0");
});
describe("/feeds/plugins/category/[category].xml handler", () => {
  it.todo("returns 200 for a known category (content) with matching entries");
  it.todo(
    "returns 404 with content-type application/atom+xml; charset=utf-8 and empty body for an unknown category",
  );
  it.todo('rejects path-traversal-style params like "../.." via KNOWN_CATEGORIES gate (404)');
  it.todo(
    "rejects mixed-case / wrapping whitespace / SQL-injection payloads via the enum gate (404)",
  );
});
