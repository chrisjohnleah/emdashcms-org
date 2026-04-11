import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";
// `?raw` imports let vitest-pool-workers bundle the source text at build
// time. Node's fs.promises is not available inside the workerd sandbox.
import embedPanelSource from "../../src/components/EmbedBadgesPanel.astro?raw";
import pluginDetailSource from "../../src/pages/plugins/[...id].astro?raw";
import dashboardPluginSource from "../../src/pages/dashboard/plugins/[id].astro?raw";
import auditConsumerSource from "../../src/lib/audit/consumer.ts?raw";
import approveVersionSource from "../../src/pages/api/v1/admin/plugins/[...id]/approve-version.ts?raw";
import rejectVersionSource from "../../src/pages/api/v1/admin/plugins/[...id]/reject-version.ts?raw";
import revokeVersionSource from "../../src/pages/api/v1/admin/plugins/[...id]/revoke-version.ts?raw";
import revokePluginSource from "../../src/pages/api/v1/admin/plugins/[...id]/revoke.ts?raw";
import restorePluginSource from "../../src/pages/api/v1/admin/plugins/[...id]/restore.ts?raw";
import {
  renderBadge,
  BADGE_COLORS,
  xmlEscape,
} from "../../src/lib/badges/render";
import {
  getBadgeData,
  buildBadgeContent,
  formatCount,
  BADGE_METRICS,
  type BadgeData,
} from "../../src/lib/badges/metrics";
import { purgeBadges } from "../../src/lib/badges/purge";
import { handleBadgeRequest } from "../../src/lib/badges/handler";

// ---------------------------------------------------------------------------
// Seed data — one "real" plugin with a published AI-reviewed version, plus
// one scoped plugin id to cover the @scope/name URL-encoding path.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "badge-author",
        9001,
        "badge-dev",
        "https://avatars.githubusercontent.com/u/9001",
        1,
        "2026-04-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
  ]);

  const pluginSql =
    "INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB
      .prepare(pluginSql)
      .bind(
        "handler-test",
        "badge-author",
        "Handler Test Plugin",
        "Test plugin for badge handler tests.",
        "content",
        "[]",
        "[]",
        "https://github.com/badge-dev/handler-test",
        null,
        null,
        "MIT",
        523,
        "active",
        "2026-04-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
    env.DB
      .prepare(pluginSql)
      .bind(
        "@scope/badge-test",
        "badge-author",
        "Scoped Badge Test",
        "Scoped plugin id for URL encoding coverage.",
        "content",
        "[]",
        "[]",
        null,
        null,
        null,
        "MIT",
        42,
        "active",
        "2026-04-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
  ]);

  const versionSql =
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB
      .prepare(versionSql)
      .bind(
        "pv-handler-1",
        "handler-test",
        "1.4.2",
        "published",
        "bundles/handler-test/1.4.2.tar.gz",
        '{"id":"handler-test","version":"1.4.2","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}',
        5,
        10000,
        25000,
        "1.2.0",
        "sha256:aaaa",
        "Initial release.",
        "# Handler Test",
        "2026-04-02T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "2026-04-02T00:00:00Z",
      ),
    env.DB
      .prepare(versionSql)
      .bind(
        "pv-scoped-1",
        "@scope/badge-test",
        "0.1.0",
        "published",
        "bundles/scoped/0.1.0.tar.gz",
        '{"id":"@scope/badge-test","version":"0.1.0","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}',
        3,
        5000,
        12000,
        null,
        "sha256:bbbb",
        "Scoped plugin initial release.",
        "# Scoped",
        "2026-04-02T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "2026-04-02T00:00:00Z",
      ),
  ]);

  const auditSql =
    "INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB
      .prepare(auditSql)
      .bind(
        "audit-handler-1",
        "pv-handler-1",
        "completed",
        "@cf/google/gemma-4-26b-a4b-it",
        1000,
        200,
        100,
        null,
        "[]",
        "pass",
        5,
        "[]",
        "2026-04-02T00:00:00Z",
      ),
    env.DB
      .prepare(auditSql)
      .bind(
        "audit-scoped-1",
        "pv-scoped-1",
        "completed",
        "static-only",
        0,
        0,
        0,
        null,
        "[]",
        null,
        0,
        "[]",
        "2026-04-02T00:00:00Z",
      ),
  ]);
});

// ---------------------------------------------------------------------------
// Render library
// ---------------------------------------------------------------------------

describe("badges/render", () => {
  it("xmlEscape escapes the five reserved XML characters", () => {
    expect(xmlEscape("a<b&c")).toBe("a&lt;b&amp;c");
    expect(xmlEscape('say "hi"')).toBe("say &quot;hi&quot;");
    expect(xmlEscape("it's")).toBe("it&apos;s");
    expect(xmlEscape("a>b")).toBe("a&gt;b");
  });

  it("xmlEscape passes em-dash through unchanged (valid UTF-8 in XML text)", () => {
    expect(xmlEscape("Scanned — Caution")).toBe("Scanned — Caution");
    expect(xmlEscape("AI-reviewed — Caution")).toBe("AI-reviewed — Caution");
  });

  it("BADGE_COLORS exposes the locked hex palette", () => {
    expect(BADGE_COLORS.success).toBe("#3fb950");
    expect(BADGE_COLORS.warn).toBe("#d29922");
    expect(BADGE_COLORS.danger).toBe("#f85149");
    expect(BADGE_COLORS.muted).toBe("#8b949e");
    expect(BADGE_COLORS.label).toBe("#555");
  });

  it("renderBadge returns a well-formed SVG containing label and value", () => {
    const svg = renderBadge("installs", "1.2k", BADGE_COLORS.success);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain("installs");
    expect(svg).toContain("1.2k");
    expect(svg).toContain(BADGE_COLORS.success);
    expect(svg).toContain('font-family="Verdana');
    expect(svg).toContain('role="img"');
    expect(svg).toContain("</svg>");
  });

  it("renderBadge escapes hostile user content in both segments", () => {
    const svg = renderBadge("label", "<script>alert(1)</script>", BADGE_COLORS.muted);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// Metrics library (pure formatters)
// ---------------------------------------------------------------------------

describe("badges/metrics", () => {
  it("BADGE_METRICS exposes the five locked metric names in the D-01 order", () => {
    expect([...BADGE_METRICS]).toEqual([
      "installs",
      "version",
      "trust-tier",
      "audit-verdict",
      "compat",
    ]);
  });

  it("formatCount produces Shields-style abbreviations", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1k");
    expect(formatCount(1500)).toBe("1.5k");
    expect(formatCount(9999)).toBe("10k");
    expect(formatCount(12345)).toBe("12k");
    expect(formatCount(1_200_000)).toBe("1.2M");
    expect(formatCount(5_000_000)).toBe("5M");
  });

  const baseData = (overrides: Partial<BadgeData> = {}): BadgeData => ({
    pluginExists: true,
    pluginStatus: "active",
    installsCount: 0,
    latestVersion: null,
    latestVersionStatus: null,
    latestAuditVerdict: null,
    latestAuditModel: null,
    minEmDashVersion: null,
    ...overrides,
  });

  describe("installs metric", () => {
    it("formats counts for an existing plugin", () => {
      const out = buildBadgeContent("installs", baseData({ installsCount: 523 }));
      expect(out).toEqual({ label: "installs", value: "523", color: BADGE_COLORS.success });
    });
    it("renders unknown/muted when plugin does not exist", () => {
      const out = buildBadgeContent("installs", baseData({ pluginExists: false }));
      expect(out).toEqual({ label: "installs", value: "unknown", color: BADGE_COLORS.muted });
    });
  });

  describe("version metric", () => {
    it("prefixes semver with v for a published version", () => {
      const out = buildBadgeContent("version", baseData({ latestVersion: "1.4.2", latestVersionStatus: "published" }));
      expect(out).toEqual({ label: "version", value: "v1.4.2", color: BADGE_COLORS.success });
    });
    it("renders unknown/muted when no published version exists", () => {
      const out = buildBadgeContent("version", baseData({ latestVersion: null }));
      expect(out).toEqual({ label: "version", value: "unknown", color: BADGE_COLORS.muted });
    });
  });

  describe("trust-tier metric", () => {
    it("AI-reviewed for published + AI model", () => {
      const out = buildBadgeContent(
        "trust-tier",
        baseData({
          latestVersionStatus: "published",
          latestAuditModel: "@cf/google/gemma-4-26b-a4b-it",
        }),
      );
      expect(out).toEqual({ label: "trust", value: "AI-reviewed", color: BADGE_COLORS.success });
    });
    it("Scanned for published + static-only", () => {
      const out = buildBadgeContent(
        "trust-tier",
        baseData({ latestVersionStatus: "published", latestAuditModel: "static-only" }),
      );
      expect(out).toEqual({ label: "trust", value: "Scanned", color: BADGE_COLORS.success });
    });
    it("Scanned — Caution for flagged + static-only (em-dash verbatim)", () => {
      const out = buildBadgeContent(
        "trust-tier",
        baseData({ latestVersionStatus: "flagged", latestAuditModel: "static-only" }),
      );
      expect(out).toEqual({
        label: "trust",
        value: "Scanned — Caution",
        color: BADGE_COLORS.warn,
      });
    });
    it("AI-reviewed — Caution for flagged + AI model (em-dash verbatim)", () => {
      const out = buildBadgeContent(
        "trust-tier",
        baseData({
          latestVersionStatus: "flagged",
          latestAuditModel: "@cf/google/gemma-4-26b-a4b-it",
        }),
      );
      expect(out).toEqual({
        label: "trust",
        value: "AI-reviewed — Caution",
        color: BADGE_COLORS.warn,
      });
    });
    it("Unreviewed/muted when no version is known", () => {
      const out = buildBadgeContent("trust-tier", baseData({ latestVersionStatus: null }));
      expect(out).toEqual({ label: "trust", value: "unknown", color: BADGE_COLORS.muted });
    });
    it("unknown/muted when plugin does not exist", () => {
      const out = buildBadgeContent(
        "trust-tier",
        baseData({ pluginExists: false, latestVersionStatus: null }),
      );
      expect(out).toEqual({ label: "trust", value: "unknown", color: BADGE_COLORS.muted });
    });
  });

  describe("audit-verdict metric", () => {
    it("passing/success for verdict pass", () => {
      const out = buildBadgeContent("audit-verdict", baseData({ latestAuditVerdict: "pass" }));
      expect(out).toEqual({ label: "audit", value: "passing", color: BADGE_COLORS.success });
    });
    it("warnings/warn for verdict warn", () => {
      const out = buildBadgeContent("audit-verdict", baseData({ latestAuditVerdict: "warn" }));
      expect(out).toEqual({ label: "audit", value: "warnings", color: BADGE_COLORS.warn });
    });
    it("failing/danger for verdict fail", () => {
      const out = buildBadgeContent("audit-verdict", baseData({ latestAuditVerdict: "fail" }));
      expect(out).toEqual({ label: "audit", value: "failing", color: BADGE_COLORS.danger });
    });
    it("unreviewed/muted when no verdict present", () => {
      const out = buildBadgeContent("audit-verdict", baseData({ latestAuditVerdict: null }));
      expect(out).toEqual({ label: "audit", value: "unreviewed", color: BADGE_COLORS.muted });
    });
    it("unknown/muted when plugin does not exist", () => {
      const out = buildBadgeContent(
        "audit-verdict",
        baseData({ pluginExists: false }),
      );
      expect(out).toEqual({ label: "audit", value: "unknown", color: BADGE_COLORS.muted });
    });
  });

  describe("compat metric", () => {
    it("≥ X.Y.Z when min_emdash_version is set", () => {
      const out = buildBadgeContent("compat", baseData({ minEmDashVersion: "1.2.0" }));
      expect(out).toEqual({ label: "emdash", value: "≥ 1.2.0", color: BADGE_COLORS.success });
    });
    it("any/muted when min_emdash_version is null", () => {
      const out = buildBadgeContent("compat", baseData({ minEmDashVersion: null }));
      expect(out).toEqual({ label: "emdash", value: "any", color: BADGE_COLORS.muted });
    });
    it("unknown/muted when plugin does not exist", () => {
      const out = buildBadgeContent("compat", baseData({ pluginExists: false }));
      expect(out).toEqual({ label: "emdash", value: "unknown", color: BADGE_COLORS.muted });
    });
  });
});

// ---------------------------------------------------------------------------
// getBadgeData — single D1 read
// ---------------------------------------------------------------------------

describe("badges/getBadgeData", () => {
  it("returns pluginExists:false for an unknown plugin id", async () => {
    const data = await getBadgeData(env.DB, "does-not-exist");
    expect(data.pluginExists).toBe(false);
    expect(data.installsCount).toBe(0);
    expect(data.latestVersion).toBeNull();
    expect(data.latestVersionStatus).toBeNull();
    expect(data.latestAuditVerdict).toBeNull();
    expect(data.latestAuditModel).toBeNull();
    expect(data.minEmDashVersion).toBeNull();
  });

  it("hydrates every metric field for a seeded plugin", async () => {
    const data = await getBadgeData(env.DB, "handler-test");
    expect(data.pluginExists).toBe(true);
    expect(data.installsCount).toBe(523);
    expect(data.latestVersion).toBe("1.4.2");
    expect(data.latestVersionStatus).toBe("published");
    expect(data.latestAuditVerdict).toBe("pass");
    expect(data.latestAuditModel).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(data.minEmDashVersion).toBe("1.2.0");
  });

  it("hydrates a scoped-id plugin with null min_emdash_version", async () => {
    const data = await getBadgeData(env.DB, "@scope/badge-test");
    expect(data.pluginExists).toBe(true);
    expect(data.installsCount).toBe(42);
    expect(data.latestVersion).toBe("0.1.0");
    expect(data.latestAuditVerdict).toBeNull();
    expect(data.latestAuditModel).toBe("static-only");
    expect(data.minEmDashVersion).toBeNull();
  });

  it("executes exactly one db.prepare per call", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();
    await getBadgeData(env.DB, "handler-test");
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// purgeBadges helper
// ---------------------------------------------------------------------------

describe("badges/purge", () => {
  it("calls caches.default.delete for all five metric URLs", async () => {
    const deleteSpy = vi
      .spyOn(caches.default, "delete")
      .mockResolvedValue(true);
    try {
      await purgeBadges("https://emdashcms.org", "myplugin");
      expect(deleteSpy).toHaveBeenCalledTimes(5);
      const urls = deleteSpy.mock.calls.map((c) => c[0]);
      expect(urls).toEqual(
        BADGE_METRICS.map(
          (m) => `https://emdashcms.org/badges/v1/plugin/myplugin/${m}.svg`,
        ),
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("URL-encodes scoped plugin ids", async () => {
    const deleteSpy = vi
      .spyOn(caches.default, "delete")
      .mockResolvedValue(true);
    try {
      await purgeBadges("https://emdashcms.org", "@scope/name");
      expect(deleteSpy).toHaveBeenCalledTimes(5);
      for (const [url] of deleteSpy.mock.calls) {
        expect(url).toContain("%40scope%2Fname");
      }
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("swallows per-URL errors and keeps purging the rest", async () => {
    const deleteSpy = vi
      .spyOn(caches.default, "delete")
      .mockImplementationOnce(() => Promise.resolve(true))
      .mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementation(() => Promise.resolve(true));
    try {
      await expect(
        purgeBadges("https://emdashcms.org", "myplugin"),
      ).resolves.toBeUndefined();
      expect(deleteSpy).toHaveBeenCalledTimes(5);
    } finally {
      deleteSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// handleBadgeRequest — full route handler (cache, rate limit, routing)
// ---------------------------------------------------------------------------

describe("badges/handler", () => {
  // Build a mock env that mirrors the test env but swaps the rate
  // limiter for a vi.fn so individual tests can flip success/failure.
  function mockEnv(rlSuccess = true): Env {
    return {
      ...(env as unknown as Env),
      GENERAL_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: rlSuccess }),
      } as unknown as RateLimit,
    };
  }

  it("returns svg with correct content-type and MISS on first request", async () => {
    const req = new Request(
      "https://handler-test-a.example/badges/v1/plugin/handler-test/installs.svg",
    );
    const res = await handleBadgeRequest(req, mockEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    );
    expect(res.headers.get("CF-Cache-Status")).toBe("MISS");
    const body = await res.text();
    expect(body.startsWith("<svg ")).toBe(true);
    expect(body).toContain("installs");
    expect(body).toContain("523");
  });

  it("returns HIT on second request for same URL", async () => {
    const url =
      "https://handler-test-b.example/badges/v1/plugin/handler-test/version.svg";
    const first = await handleBadgeRequest(new Request(url), mockEnv());
    expect(first.headers.get("CF-Cache-Status")).toBe("MISS");
    // Drain body to ensure cache.put completes.
    await first.arrayBuffer();

    const second = await handleBadgeRequest(new Request(url), mockEnv());
    expect(second.status).toBe(200);
    expect(second.headers.get("CF-Cache-Status")).toBe("HIT");
  });

  it("returns 200 muted unknown badge for unknown plugin id (never 404)", async () => {
    const res = await handleBadgeRequest(
      new Request(
        "https://handler-test-c.example/badges/v1/plugin/nonexistent/trust-tier.svg",
      ),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("unknown");
    expect(body).toContain("#8b949e"); // muted color
  });

  it("returns 400 with Cache-Control: no-store for bad metric name", async () => {
    const res = await handleBadgeRequest(
      new Request(
        "https://handler-test-d.example/badges/v1/plugin/handler-test/banana.svg",
      ),
      mockEnv(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
  });

  it("returns 429 when rate limiter rejects, without touching the DB", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();
    const res = await handleBadgeRequest(
      new Request(
        "https://handler-test-e.example/badges/v1/plugin/handler-test/installs.svg",
      ),
      mockEnv(false),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(prepareSpy).not.toHaveBeenCalled();
    prepareSpy.mockRestore();
  });

  it("does not set any Set-Cookie header (D-17, anonymous access)", async () => {
    const res = await handleBadgeRequest(
      new Request(
        "https://handler-test-f.example/badges/v1/plugin/handler-test/audit-verdict.svg",
      ),
      mockEnv(),
    );
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("decodes URL-encoded scoped plugin ids and hydrates the real row", async () => {
    const res = await handleBadgeRequest(
      new Request(
        "https://handler-test-g.example/badges/v1/plugin/%40scope%2Fbadge-test/installs.svg",
      ),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // The scoped plugin was seeded with installs_count=42.
    expect(body).toContain("42");
  });

  it("performs exactly one D1 prepare per cache miss", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();
    const res = await handleBadgeRequest(
      new Request(
        "https://handler-test-h.example/badges/v1/plugin/handler-test/compat.svg",
      ),
      mockEnv(),
    );
    await res.arrayBuffer();
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });

  it("ignores query strings when keying the cache (T-13-03)", async () => {
    // First request populates cache for the canonical pathname.
    const canonical =
      "https://handler-test-i.example/badges/v1/plugin/handler-test/trust-tier.svg";
    const first = await handleBadgeRequest(new Request(canonical), mockEnv());
    expect(first.headers.get("CF-Cache-Status")).toBe("MISS");
    await first.arrayBuffer();

    // Second request with a junk query string should still HIT — the
    // cache key is derived from pathname only.
    const poisoned = canonical + "?garbage=1&poison=true";
    const second = await handleBadgeRequest(new Request(poisoned), mockEnv());
    expect(second.headers.get("CF-Cache-Status")).toBe("HIT");
  });
});

// ---------------------------------------------------------------------------
// Embed panel mount (13-02) — file-level assertions because the component
// itself is a pure Astro template (no JS islands) and the real clipboard
// wiring is manual-only per 13-VALIDATION.md Manual-Only Verifications.
// ---------------------------------------------------------------------------

describe("embed panel mount", () => {
  it("public plugin detail imports and mounts EmbedBadgesPanel", () => {
    expect(pluginDetailSource).toMatch(/import\s+EmbedBadgesPanel\s+from/);
    expect(pluginDetailSource).toMatch(
      /<EmbedBadgesPanel[^/>]*pluginId=\{plugin\.id\}/,
    );
    expect(pluginDetailSource).toMatch(/origin=\{Astro\.url\.origin\}/);
  });

  it("dashboard plugin detail imports and mounts EmbedBadgesPanel", () => {
    expect(dashboardPluginSource).toMatch(/import\s+EmbedBadgesPanel\s+from/);
    expect(dashboardPluginSource).toMatch(/<EmbedBadgesPanel/);
    expect(dashboardPluginSource).toMatch(/origin=\{Astro\.url\.origin\}/);
  });

  it("EmbedBadgesPanel URL-encodes scoped plugin ids", () => {
    expect(embedPanelSource).toMatch(/encodeURIComponent\(pluginId\)/);
  });

  it("EmbedBadgesPanel imports BADGE_METRICS from the library to avoid drift", () => {
    expect(embedPanelSource).toMatch(/BADGE_METRICS/);
    expect(embedPanelSource).toMatch(
      /from\s+["']\.\.\/lib\/badges\/metrics["']/,
    );
  });

  it("EmbedBadgesPanel wires clipboard via a single inline script", () => {
    expect(embedPanelSource).toMatch(/navigator\.clipboard\.writeText/);
    // The component ships with exactly one `<script is:inline>` block —
    // strip the comment/template strings before counting so an update
    // to the comment text cannot desynchronise the assertion. We match
    // the block opener at column zero (no leading word chars) so the
    // literal referenced in a code comment or string is not counted.
    const openTags = embedPanelSource.match(/^<script\s+is:inline>/gm) ?? [];
    expect(openTags.length).toBe(1);
  });

  it("EmbedBadgesPanel renders live <img> previews for all five metrics", () => {
    // The preview block maps over BADGE_METRICS and emits an <img>.
    expect(embedPanelSource).toMatch(/<img/);
    expect(embedPanelSource).toMatch(/BADGE_METRICS\.map/);
  });

  it("EmbedBadgesPanel exposes all-markdown and all-html snippet blocks", () => {
    expect(embedPanelSource).toMatch(/ebp-md-all/);
    expect(embedPanelSource).toMatch(/ebp-html-all/);
  });
});

// ---------------------------------------------------------------------------
// Badge purge call sites (13-02) — file-level assertions against the 6
// mutation surfaces (audit consumer + 5 admin routes). The consumer
// runs from a Queue message and the admin routes are inline APIRoute
// handlers, so exercising the real code paths would require mocking R2,
// Workers AI, and the middleware auth layer. File-level grep still
// proves the wiring is in place and catches accidental removal during
// future refactors — the actual runtime behaviour is covered by the
// purgeBadges unit tests above (fans out to 5 URL-encoded cache keys,
// swallows per-URL errors).
// ---------------------------------------------------------------------------

describe("badges/purge call sites", () => {
  it("audit consumer imports purgeBadges and SITE_ORIGIN", () => {
    expect(auditConsumerSource).toMatch(
      /import\s*\{\s*purgeBadges\s*\}\s*from\s+["']\.\.\/badges\/purge["']/,
    );
    expect(auditConsumerSource).toMatch(
      /const\s+SITE_ORIGIN\s*=\s*["']https:\/\/emdashcms\.org["']/,
    );
  });

  it("audit consumer calls purgeBadges after every createAuditRecord", () => {
    // 5 createAuditRecord sites (static-first reject, static-first
    // publish/flagged, manual mode, budget-exhausted, AI verdict) each
    // get one purge call.
    const purgeCalls = auditConsumerSource.match(
      /await\s+purgeBadges\(SITE_ORIGIN,\s*job\.pluginId\)/g,
    );
    expect(purgeCalls?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("audit consumer wraps each purge in try/catch (D-15 defense)", () => {
    // Each purge call must be inside a try block so an outer failure
    // cannot strand the audit pipeline. The cheapest check: every
    // purgeBadges call in the consumer is preceded by a `try {`.
    const lines = auditConsumerSource.split("\n");
    let protectedCalls = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/await\s+purgeBadges\(/.test(lines[i])) {
        // Look backwards up to 3 lines for a try block opener.
        for (let j = Math.max(0, i - 3); j < i; j++) {
          if (/\btry\s*\{/.test(lines[j])) {
            protectedCalls++;
            break;
          }
        }
      }
    }
    expect(protectedCalls).toBeGreaterThanOrEqual(5);
  });

  it("audit consumer documents the regional purge limitation on SITE_ORIGIN", () => {
    // The hardcoded prod origin is only safe because purges are
    // colo-local. That justification must survive in a comment near
    // the constant so a future reader doesn't "fix" it to a generic env var.
    expect(auditConsumerSource).toMatch(/REGIONAL PURGE LIMITATION/);
  });

  for (const [name, source] of [
    ["approve-version", approveVersionSource],
    ["reject-version", rejectVersionSource],
    ["revoke-version", revokeVersionSource],
    ["revoke", revokePluginSource],
    ["restore", restorePluginSource],
  ] as const) {
    describe(`admin/${name}`, () => {
      it("imports purgeBadges from the badges library", () => {
        expect(source).toMatch(
          /import\s*\{\s*purgeBadges\s*\}\s*from\s+["'][^"']*\/badges\/purge["']/,
        );
      });

      it("derives the origin from the request URL", () => {
        expect(source).toMatch(/new URL\(request\.url\)\.origin/);
      });

      it("invokes purgeBadges with the request origin and plugin id", () => {
        expect(source).toMatch(
          /await\s+purgeBadges\(\s*new URL\(request\.url\)\.origin,\s*pluginId\s*\)/,
        );
      });

      it("wraps purgeBadges in a best-effort try/catch", () => {
        // Match a try block whose body contains the purgeBadges call —
        // the [\s\S] + non-greedy body lets us assert the pair without
        // caring about the exact comment/indentation in between.
        expect(source).toMatch(
          /try\s*\{[\s\S]*?await\s+purgeBadges\(/,
        );
        expect(source).toMatch(/\}\s*catch\s*\([^)]*\)\s*\{[\s\S]*?\[badges\]/);
      });
    });
  }

  it("purgeBadges itself does not throw when caches.default.delete rejects (defense-in-depth)", async () => {
    // The helper swallows per-URL errors. This is the unit-level
    // guarantee the call sites rely on so that their outer try/catch
    // only has to catch import/module failures, not per-URL fan-out.
    const originalCache = (caches as unknown as { default: Cache }).default;
    const brokenCache: Cache = {
      ...originalCache,
      delete: () => Promise.reject(new Error("purge failed")),
    } as Cache;
    Object.defineProperty(caches, "default", {
      configurable: true,
      get: () => brokenCache,
    });
    try {
      await expect(
        purgeBadges("https://test.example", "unit-test-plugin"),
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(caches, "default", {
        configurable: true,
        get: () => originalCache,
      });
    }
  });
});
