import { describe, it } from "vitest";
// Coverage for FEED-05/FEED-06 page rendering + slug validation.

describe("/digest/[slug] route", () => {
  it.todo("parseIsoWeekSlug rejects '2026-15' -> page returns 404");
  it.todo("parseIsoWeekSlug rejects '../admin' -> page returns 404 (T-14-03 path traversal)");
  it.todo("parseIsoWeekSlug rejects empty string -> page returns 404");
  it.todo("missing weekly_digests row returns 404 with Astro.response.status = 404");
  it.todo("valid slug with existing row renders manifest_json contents");
  it.todo("page does NOT query plugins/themes/plugin_versions tables (snapshot-only per D-20)");
  it.todo("renders sections: New plugins, Updated plugins, New themes (only non-empty)");
  it.todo("renders 'Quiet week — no new or updated items.' when all three arrays empty (D-30)");
});

describe("/digest index route", () => {
  it.todo("orders rows by iso_week DESC");
  it.todo("renders counts per row (derived from manifest_json.counts)");
  it.todo("renders 'No digests yet' empty state when table is empty");
  it.todo("caps query at 100 rows (defensive)");
});
