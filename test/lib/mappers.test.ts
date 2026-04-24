import { describe, it, expect } from "vitest";
import { mapPluginSummary, mapPluginDetail } from "../../src/lib/db/mappers";

/**
 * Plain-object mapper tests — no D1 binding needed because mapPluginSummary
 * and mapPluginDetail both consume `Record<string, unknown>`. This keeps
 * the phase-17 deprecation branches fast to assert without having to seed
 * a full plugin row via migrations.
 */

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plug-1",
    name: "Plug One",
    short_description: "short",
    description: "desc",
    capabilities: '["fetch"]',
    keywords: '["seo"]',
    installs_count: 10,
    downloads_count: 20,
    icon_key: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    category: "seo",
    repository_url: null,
    homepage_url: null,
    license: null,
    status: "active",
    github_username: "alice",
    avatar_url: null,
    verified: 1,
    latest_version: "1.0.0",
    latest_version_status: "published",
    latest_audit_verdict: null,
    latest_audit_risk_score: null,
    latest_audit_findings: "[]",
    deprecated_at: null,
    deprecated_reason_category: null,
    deprecated_reason_note: null,
    successor_id: null,
    unlisted_at: null,
    successor_plugin_id: null,
    successor_name: null,
    successor_deprecated_at: null,
    successor_unlisted_at: null,
    ...overrides,
  };
}

describe("mapPluginSummary + mapPluginDetail deprecation", () => {
  it("active plugin — deprecated:false, unlisted:false, deprecation:null", () => {
    const row = baseRow();
    const summary = mapPluginSummary(row);
    expect(summary.deprecated).toBe(false);
    expect(summary.unlisted).toBe(false);

    const detail = mapPluginDetail(row, null);
    expect(detail.deprecation).toBeNull();
  });

  it("deprecated plugin without a successor — flags flip, deprecation populated", () => {
    const row = baseRow({
      deprecated_at: "2026-02-03T10:00:00Z",
      deprecated_reason_category: "unmaintained",
      deprecated_reason_note: "Won't be updated for EmDash 3.x",
    });
    const summary = mapPluginSummary(row);
    expect(summary.deprecated).toBe(true);
    expect(summary.unlisted).toBe(false);

    const detail = mapPluginDetail(row, null);
    expect(detail.deprecation).not.toBeNull();
    expect(detail.deprecation?.category).toBe("unmaintained");
    expect(detail.deprecation?.note).toBe("Won't be updated for EmDash 3.x");
    expect(detail.deprecation?.deprecatedAt).toBe("2026-02-03T10:00:00Z");
    expect(detail.deprecation?.successor).toBeNull();
  });

  it("deprecated plugin with a live successor — deprecation.successor is resolved", () => {
    const row = baseRow({
      deprecated_at: "2026-02-03T10:00:00Z",
      deprecated_reason_category: "replaced",
      deprecated_reason_note: "See successor",
      successor_id: "plug-2",
      successor_plugin_id: "plug-2",
      successor_name: "Plug Two",
      successor_deprecated_at: null,
      successor_unlisted_at: null,
    });
    const detail = mapPluginDetail(row, null);
    expect(detail.deprecation?.successor).toEqual({
      id: "plug-2",
      name: "Plug Two",
      url: "/plugins/plug-2",
    });
  });

  it("deprecated plugin whose successor is itself deprecated — broken-chain defence", () => {
    const row = baseRow({
      deprecated_at: "2026-02-03T10:00:00Z",
      deprecated_reason_category: "replaced",
      successor_id: "plug-2",
      successor_plugin_id: "plug-2",
      successor_name: "Plug Two",
      successor_deprecated_at: "2026-03-01T10:00:00Z",
      successor_unlisted_at: null,
    });
    const detail = mapPluginDetail(row, null);
    expect(detail.deprecation).not.toBeNull();
    expect(detail.deprecation?.successor).toBeNull();
  });

  it("unlisted plugin — unlisted flag flips on summary", () => {
    const row = baseRow({ unlisted_at: "2026-02-03T10:00:00Z" });
    const summary = mapPluginSummary(row);
    expect(summary.unlisted).toBe(true);
    expect(summary.deprecated).toBe(false);
  });
});
