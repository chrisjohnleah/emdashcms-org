import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  searchPlugins,
  getPluginDetail,
  getPluginVersions,
} from "../../src/lib/db/queries";

// ---------------------------------------------------------------------------
// Seed data — mirrors seeds/dev.sql with exact IDs for deterministic assertions
// Uses db.batch() with individual prepared statements (D1 exec doesn't support multi-row INSERT)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean any existing data from prior tests in this isolate
  await env.DB.batch([
    env.DB.prepare("DELETE FROM installs"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  // Authors
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("author-1", 1001, "alice-dev", "https://avatars.githubusercontent.com/u/1001", 1, "2026-01-10T08:00:00Z", "2026-03-20T12:00:00Z"),
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("author-2", 1002, "bob-plugins", "https://avatars.githubusercontent.com/u/1002", 0, "2026-01-20T09:00:00Z", "2026-03-15T10:00:00Z"),
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("author-3", 1003, "carol-themes", "https://avatars.githubusercontent.com/u/1003", 1, "2026-02-01T10:00:00Z", "2026-03-25T14:00:00Z"),
  ]);

  // Plugins
  const pluginSql =
    "INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB.prepare(pluginSql).bind(
      "seo-toolkit", "author-1", "SEO Toolkit",
      "Comprehensive SEO tools for EmDash sites including meta tags, sitemaps, and structured data.",
      "content", '["content:write","admin:panels"]', '["seo","meta","sitemap","structured-data"]',
      "https://github.com/alice-dev/seo-toolkit", "https://seo-toolkit.example.com",
      "plugins/seo-toolkit/icon.png", "MIT", 1200,
      "2026-01-15T10:00:00Z", "2026-03-20T12:00:00Z",
    ),
    env.DB.prepare(pluginSql).bind(
      "analytics-pro", "author-1", "Analytics Pro",
      "Privacy-first analytics dashboard with real-time visitor tracking.",
      "analytics", '["admin:panels","storage:read"]', '["analytics","privacy","dashboard"]',
      "https://github.com/alice-dev/analytics-pro", null,
      "plugins/analytics-pro/icon.png", "MIT", 500,
      "2026-01-20T14:00:00Z", "2026-03-18T09:00:00Z",
    ),
    env.DB.prepare(pluginSql).bind(
      "form-builder", "author-2", "Form Builder",
      "Drag-and-drop form builder with validation and submission handling.",
      "content", '["content:write","storage:write","routes:register"]', '["forms","builder","validation"]',
      "https://github.com/bob-plugins/form-builder", null,
      null, "Apache-2.0", 150,
      "2026-02-01T11:00:00Z", "2026-03-10T16:00:00Z",
    ),
    env.DB.prepare(pluginSql).bind(
      "social-share", "author-2", "Social Share",
      "Add social sharing buttons to any page with customizable appearance.",
      "social", '["content:write"]', '["social","sharing","buttons"]',
      "https://github.com/bob-plugins/social-share", null,
      null, null, 10,
      "2026-02-15T09:00:00Z", "2026-03-05T11:00:00Z",
    ),
    env.DB.prepare(pluginSql).bind(
      "security-headers", "author-3", "Security Headers",
      "Automatically inject security headers into all responses.",
      "security", '["routes:register"]', '["security","headers","csp"]',
      "https://github.com/carol-themes/security-headers", null,
      null, "MIT", 0,
      "2026-03-01T08:00:00Z", "2026-03-25T14:00:00Z",
    ),
    env.DB.prepare(pluginSql).bind(
      "image-optimizer", "author-3", "Image Optimizer",
      "Automatic image compression and format conversion for uploaded media.",
      "content", '["content:write","storage:write"]', '["images","optimization","compression"]',
      "https://github.com/carol-themes/image-optimizer", "https://img-opt.example.com",
      "plugins/image-optimizer/icon.png", "MIT", 75,
      "2026-02-20T13:00:00Z", "2026-03-22T10:00:00Z",
    ),
  ]);

  // Plugin versions
  const versionSql =
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB.prepare(versionSql).bind(
      "pv-seo-1", "seo-toolkit", "1.0.0", "published",
      "bundles/seo-toolkit/1.0.0.tar.gz",
      '{"id":"seo-toolkit","version":"1.0.0","capabilities":["content:write","admin:panels"],"allowedHosts":[],"storage":null,"hooks":["onPageRender"],"routes":[],"admin":{"panels":["seo-panel"]}}',
      12, 45000, 120000, "1.0.0",
      "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "Initial release with meta tag management and sitemap generation.",
      "# SEO Toolkit\n\nComprehensive SEO tools for EmDash.",
      "2026-01-15T12:00:00Z", "2026-01-15T10:00:00Z", "2026-01-15T12:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-seo-2", "seo-toolkit", "1.1.0", "published",
      "bundles/seo-toolkit/1.1.0.tar.gz",
      '{"id":"seo-toolkit","version":"1.1.0","capabilities":["content:write","admin:panels"],"allowedHosts":[],"storage":null,"hooks":["onPageRender"],"routes":[],"admin":{"panels":["seo-panel"]}}',
      14, 48000, 130000, "1.0.0",
      "sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      "Added structured data support and Open Graph tags.",
      "# SEO Toolkit\n\nComprehensive SEO tools for EmDash.\n\n## v1.1.0\n- Structured data\n- Open Graph tags",
      "2026-02-10T14:00:00Z", "2026-02-10T12:00:00Z", "2026-02-10T14:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-seo-3", "seo-toolkit", "2.0.0-beta", "pending",
      "bundles/seo-toolkit/2.0.0-beta.tar.gz",
      '{"id":"seo-toolkit","version":"2.0.0-beta","capabilities":["content:write","admin:panels","storage:read"],"allowedHosts":[],"storage":{"analytics":{"type":"json"}},"hooks":["onPageRender","onBuild"],"routes":[],"admin":{"panels":["seo-panel","seo-analytics"]}}',
      18, 62000, 180000, "1.1.0",
      "sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      "Beta: SEO analytics dashboard and automated audits.",
      "# SEO Toolkit\n\n## v2.0.0-beta\n- Analytics dashboard\n- Automated SEO audits",
      null, "2026-03-20T10:00:00Z", "2026-03-20T10:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-analytics-1", "analytics-pro", "1.0.0", "published",
      "bundles/analytics-pro/1.0.0.tar.gz",
      '{"id":"analytics-pro","version":"1.0.0","capabilities":["admin:panels","storage:read"],"allowedHosts":[],"storage":{"visits":{"type":"json"}},"hooks":[],"routes":[],"admin":{"panels":["analytics-dashboard"]}}',
      8, 32000, 85000, "1.0.0",
      "sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      "Initial release with visitor tracking and dashboard.",
      "# Analytics Pro\n\nPrivacy-first analytics for EmDash.",
      "2026-01-25T16:00:00Z", "2026-01-25T14:00:00Z", "2026-01-25T16:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-analytics-2", "analytics-pro", "1.0.1", "flagged",
      "bundles/analytics-pro/1.0.1.tar.gz",
      '{"id":"analytics-pro","version":"1.0.1","capabilities":["admin:panels","storage:read"],"allowedHosts":["analytics.example.com"],"storage":{"visits":{"type":"json"}},"hooks":[],"routes":[],"admin":{"panels":["analytics-dashboard"]}}',
      9, 33000, 87000, "1.0.0",
      "sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
      "Patch: fixed data retention policy compliance.",
      "# Analytics Pro\n\n## v1.0.1\n- Fixed data retention",
      "2026-03-18T10:00:00Z", "2026-03-18T08:00:00Z", "2026-03-18T10:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-form-1", "form-builder", "1.0.0", "published",
      "bundles/form-builder/1.0.0.tar.gz",
      '{"id":"form-builder","version":"1.0.0","capabilities":["content:write","storage:write","routes:register"],"allowedHosts":[],"storage":{"submissions":{"type":"json"}},"hooks":[],"routes":["/api/forms"],"admin":null}',
      10, 38000, 95000, "1.0.0",
      "sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
      "Initial release with drag-and-drop form builder.",
      "# Form Builder\n\nDrag-and-drop forms for EmDash.",
      "2026-02-05T10:00:00Z", "2026-02-05T08:00:00Z", "2026-02-05T10:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-form-2", "form-builder", "1.1.0", "published",
      "bundles/form-builder/1.1.0.tar.gz",
      '{"id":"form-builder","version":"1.1.0","capabilities":["content:write","storage:write","routes:register"],"allowedHosts":[],"storage":{"submissions":{"type":"json"}},"hooks":[],"routes":["/api/forms","/api/forms/submit"],"admin":null}',
      13, 42000, 110000, "1.0.0",
      "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "Added email notifications and file upload fields.",
      "# Form Builder\n\n## v1.1.0\n- Email notifications\n- File upload fields",
      "2026-03-10T16:00:00Z", "2026-03-10T14:00:00Z", "2026-03-10T16:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-social-1", "social-share", "0.9.0", "rejected",
      "bundles/social-share/0.9.0.tar.gz",
      '{"id":"social-share","version":"0.9.0","capabilities":["content:write"],"allowedHosts":["*.facebook.com","*.twitter.com"],"storage":null,"hooks":[],"routes":[],"admin":null}',
      5, 15000, 40000, null,
      "sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      "Pre-release with social integrations.",
      "# Social Share\n\nSocial sharing buttons for EmDash.",
      null, "2026-02-15T09:00:00Z", "2026-02-15T09:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-social-2", "social-share", "1.0.0", "published",
      "bundles/social-share/1.0.0.tar.gz",
      '{"id":"social-share","version":"1.0.0","capabilities":["content:write"],"allowedHosts":[],"storage":null,"hooks":["onPageRender"],"routes":[],"admin":null}',
      6, 18000, 45000, "1.0.0",
      "sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      "Stable release without external host dependencies.",
      "# Social Share\n\n## v1.0.0\n- Removed external host dependencies\n- Added Open Graph support",
      "2026-03-05T12:00:00Z", "2026-03-05T10:00:00Z", "2026-03-05T12:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-security-1", "security-headers", "0.1.0", "pending",
      "bundles/security-headers/0.1.0.tar.gz",
      '{"id":"security-headers","version":"0.1.0","capabilities":["routes:register"],"allowedHosts":[],"storage":null,"hooks":[],"routes":["/*"],"admin":null}',
      4, 12000, 30000, "1.0.0",
      "sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      "Initial submission with CSP, HSTS, and X-Frame-Options.",
      "# Security Headers\n\nAutomatic security headers for EmDash.",
      null, "2026-03-25T14:00:00Z", "2026-03-25T14:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-image-1", "image-optimizer", "1.0.0", "published",
      "bundles/image-optimizer/1.0.0.tar.gz",
      '{"id":"image-optimizer","version":"1.0.0","capabilities":["content:write","storage:write"],"allowedHosts":[],"storage":{"cache":{"type":"json"}},"hooks":["onMediaUpload"],"routes":[],"admin":null}',
      7, 28000, 70000, "1.0.0",
      "sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
      "Initial release with WebP and AVIF conversion.",
      "# Image Optimizer\n\nAutomatic image optimization for EmDash.",
      "2026-02-25T10:00:00Z", "2026-02-25T08:00:00Z", "2026-02-25T10:00:00Z",
    ),
    env.DB.prepare(versionSql).bind(
      "pv-image-2", "image-optimizer", "1.1.0", "published",
      "bundles/image-optimizer/1.1.0.tar.gz",
      '{"id":"image-optimizer","version":"1.1.0","capabilities":["content:write","storage:write"],"allowedHosts":[],"storage":{"cache":{"type":"json"}},"hooks":["onMediaUpload"],"routes":[],"admin":null}',
      9, 31000, 78000, "1.0.0",
      "sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
      "Added responsive image generation and lazy loading.",
      "# Image Optimizer\n\n## v1.1.0\n- Responsive image generation\n- Lazy loading support",
      "2026-03-22T11:00:00Z", "2026-03-22T09:00:00Z", "2026-03-22T11:00:00Z",
    ),
  ]);

  // Plugin audits
  const auditSql =
    "INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB.prepare(auditSql).bind(
      "audit-seo-1", "pv-seo-1", "completed", "@cf/qwen/qwq-32b",
      3200, 800, 450, null, "[]", "pass", 5,
      '[{"severity":"info","title":"Standard DOM manipulation","description":"Plugin uses standard content:write capability for meta tag injection.","category":"permissions","location":"src/index.ts:15"}]',
      "2026-01-15T11:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-seo-2", "pv-seo-2", "completed", "@cf/qwen/qwq-32b",
      3400, 850, 470, null, "[]", "pass", 8,
      '[{"severity":"info","title":"JSON-LD injection","description":"Structured data injection uses safe JSON serialization.","category":"data-handling","location":"src/structured-data.ts:42"},{"severity":"low","title":"Large DOM queries","description":"querySelectorAll on page load may impact performance on large pages.","category":"performance","location":"src/meta-tags.ts:28"}]',
      "2026-02-10T13:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-analytics-1", "pv-analytics-1", "completed", "@cf/qwen/qwq-32b",
      2800, 700, 400, null, "[]", "pass", 12,
      '[{"severity":"low","title":"Local storage usage","description":"Stores visitor fingerprint in localStorage for session tracking.","category":"privacy","location":"src/tracker.ts:55"},{"severity":"info","title":"No external requests","description":"All data stays within EmDash storage API.","category":"network","location":null}]',
      "2026-01-25T15:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-analytics-2", "pv-analytics-2", "completed", "@cf/qwen/qwq-32b",
      3000, 750, 420, null, "[]", "warn", 38,
      '[{"severity":"medium","title":"External host communication","description":"Plugin declares allowedHosts including analytics.example.com. Data may be exfiltrated.","category":"network","location":"manifest.json:allowedHosts"},{"severity":"high","title":"Unvalidated external endpoint","description":"fetch() call to external analytics endpoint without certificate pinning.","category":"security","location":"src/sync.ts:12"},{"severity":"low","title":"Data retention unclear","description":"No clear data deletion mechanism for stored visitor data.","category":"privacy","location":"src/storage.ts:30"}]',
      "2026-03-18T09:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-form-1", "pv-form-1", "completed", "@cf/qwen/qwq-32b",
      3100, 780, 440, null, "[]", "pass", 10,
      '[{"severity":"low","title":"Route registration","description":"Registers /api/forms endpoint for form submissions.","category":"permissions","location":"src/routes.ts:5"},{"severity":"info","title":"Input sanitization present","description":"HTML input is sanitized before storage.","category":"security","location":"src/sanitize.ts:18"}]',
      "2026-02-05T09:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-form-2", "pv-form-2", "completed", "@cf/qwen/qwq-32b",
      3300, 820, 460, null, "[]", "pass", 15,
      '[{"severity":"low","title":"File upload handling","description":"Accepts file uploads via multipart form data. Files stored in EmDash storage.","category":"data-handling","location":"src/upload.ts:22"},{"severity":"info","title":"Email integration","description":"Uses EmDash notification API for email delivery, no direct SMTP.","category":"network","location":"src/notify.ts:8"}]',
      "2026-03-10T15:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-social-1", "pv-social-1", "completed", "@cf/qwen/qwq-32b",
      2500, 650, 380, null, "[]", "fail", 72,
      '[{"severity":"critical","title":"Unrestricted external hosts","description":"Declares wildcard allowedHosts for facebook.com and twitter.com subdomains. Could be used for data exfiltration.","category":"security","location":"manifest.json:allowedHosts"},{"severity":"high","title":"DOM content extraction","description":"Reads full page content before sharing, potential data leak to external services.","category":"privacy","location":"src/share.ts:34"}]',
      "2026-02-15T10:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-social-2", "pv-social-2", "completed", "@cf/qwen/qwq-32b",
      2600, 680, 390, null, "[]", "pass", 3,
      '[{"severity":"info","title":"No external hosts","description":"Sharing uses native Web Share API and client-side URL construction only.","category":"network","location":"src/share.ts:10"}]',
      "2026-03-05T11:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-image-1", "pv-image-1", "completed", "@cf/qwen/qwq-32b",
      2900, 720, 410, null, "[]", "pass", 8,
      '[{"severity":"info","title":"Media hook usage","description":"Listens to onMediaUpload hook for automatic processing.","category":"permissions","location":"src/index.ts:5"},{"severity":"low","title":"CPU-intensive operation","description":"Image conversion may be CPU-intensive for large files.","category":"performance","location":"src/convert.ts:45"}]',
      "2026-02-25T09:00:00Z",
    ),
    env.DB.prepare(auditSql).bind(
      "audit-image-2", "pv-image-2", "completed", "@cf/qwen/qwq-32b",
      3100, 760, 430, null, "[]", "pass", 10,
      '[{"severity":"low","title":"Multiple output formats","description":"Generates WebP, AVIF, and responsive variants which increases storage usage.","category":"resource-usage","location":"src/responsive.ts:20"},{"severity":"info","title":"Lazy loading injection","description":"Adds loading=lazy attribute to img tags via content:write.","category":"permissions","location":"src/lazy.ts:8"}]',
      "2026-03-22T10:00:00Z",
    ),
  ]);
});

// ---------------------------------------------------------------------------
// DISC-01: Plugin Search
// ---------------------------------------------------------------------------

describe("Plugin Search (DISC-01)", () => {
  it("returns items array and nextCursor", async () => {
    const result = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result).toHaveProperty("nextCursor");
  });

  it("filters by query text (case-insensitive)", async () => {
    const result = await searchPlugins(env.DB, {
      query: "seo",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      const matchesName = item.name.toLowerCase().includes("seo");
      const matchesDesc = item.description?.toLowerCase().includes("seo");
      expect(matchesName || matchesDesc).toBe(true);
    }
  });

  it("filters by category", async () => {
    const result = await searchPlugins(env.DB, {
      query: "",
      category: "content",
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    const ids = result.items.map((p) => p.id);
    expect(ids).toContain("seo-toolkit");
    expect(ids).toContain("form-builder");
    expect(ids).toContain("image-optimizer");
    // analytics-pro is "analytics", should NOT be present
    expect(ids).not.toContain("analytics-pro");
  });

  it("filters by capability using json_each", async () => {
    const result = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: "content:write",
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      expect(item.capabilities).toContain("content:write");
    }
  });

  it("sorts by name ascending", async () => {
    const result = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "name",
      cursor: null,
      limit: 20,
    });

    const names = result.items.map((p) => p.name);
    // SQLite default collation is binary (case-sensitive ASCII order)
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("sorts by installs descending (default)", async () => {
    const result = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    const counts = result.items.map((p) => p.installCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });

  it("paginates with limit and cursor", async () => {
    // Get first page of 2
    const page1 = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 2,
    });

    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // Get second page using cursor
    const page2 = await searchPlugins(env.DB, {
      query: "",
      category: null,
      capability: null,
      sort: "installs",
      cursor: page1.nextCursor,
      limit: 2,
    });

    expect(page2.items.length).toBeGreaterThanOrEqual(1);

    // No duplicates between pages
    const page1Ids = page1.items.map((p) => p.id);
    const page2Ids = page2.items.map((p) => p.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  it("returns empty items for no-match query", async () => {
    const result = await searchPlugins(env.DB, {
      query: "zzz-nonexistent-plugin-zzz",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("returns correct MarketplacePluginSummary shape", async () => {
    const result = await searchPlugins(env.DB, {
      query: "SEO Toolkit",
      category: null,
      capability: null,
      sort: "installs",
      cursor: null,
      limit: 20,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    const seo = result.items.find((p) => p.id === "seo-toolkit");
    expect(seo).toBeDefined();

    // Verify shape: all required fields
    expect(typeof seo!.id).toBe("string");
    expect(typeof seo!.name).toBe("string");
    expect(typeof seo!.author.name).toBe("string");
    expect(typeof seo!.author.verified).toBe("boolean");
    expect(seo!.author.verified).toBe(true); // alice-dev is verified (1 -> boolean)
    expect(Array.isArray(seo!.capabilities)).toBe(true);
    expect(Array.isArray(seo!.keywords)).toBe(true);
    expect(typeof seo!.installCount).toBe("number");
    expect(typeof seo!.hasIcon).toBe("boolean");
    expect(typeof seo!.createdAt).toBe("string");
    expect(typeof seo!.updatedAt).toBe("string");

    // latestVersion should exist for seo-toolkit (has published versions)
    expect(seo!.latestVersion).not.toBeNull();
    expect(seo!.latestVersion!.version).toBe("1.1.0");
    expect(seo!.latestVersion!.audit).not.toBeNull();
    expect(seo!.latestVersion!.audit!.verdict).toBe("pass");
    expect(typeof seo!.latestVersion!.audit!.riskScore).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// DISC-02: Plugin Detail
// ---------------------------------------------------------------------------

describe("Plugin Detail (DISC-02)", () => {
  it("returns full plugin detail with author", async () => {
    const plugin = await getPluginDetail(env.DB, "seo-toolkit");

    expect(plugin).not.toBeNull();
    expect(plugin!.id).toBe("seo-toolkit");
    expect(plugin!.name).toBe("SEO Toolkit");
    expect(plugin!.author.name).toBe("alice-dev");
    expect(plugin!.author.verified).toBe(true);
    expect(typeof plugin!.author.avatarUrl).toBe("string");

    // Detail-specific fields
    expect(plugin!.repositoryUrl).toBe(
      "https://github.com/alice-dev/seo-toolkit",
    );
    expect(plugin!.homepageUrl).toBe("https://seo-toolkit.example.com");
    expect(plugin!.license).toBe("MIT");
  });

  it("includes latestVersion with audit detail", async () => {
    const plugin = await getPluginDetail(env.DB, "seo-toolkit");

    expect(plugin).not.toBeNull();
    expect(plugin!.latestVersion).not.toBeNull();
    expect(plugin!.latestVersion!.version).toBe("1.1.0");
    expect(typeof plugin!.latestVersion!.bundleSize).toBe("number");
    expect(typeof plugin!.latestVersion!.checksum).toBe("string");
    expect(Array.isArray(plugin!.latestVersion!.capabilities)).toBe(true);
    expect(plugin!.latestVersion!.status).toBe("published");

    // Audit detail (not just summary)
    expect(plugin!.latestVersion!.audit).not.toBeNull();
    expect(plugin!.latestVersion!.audit!.verdict).toBe("pass");
    expect(typeof plugin!.latestVersion!.audit!.riskScore).toBe("number");
    expect(Array.isArray(plugin!.latestVersion!.audit!.findings)).toBe(true);
    expect(plugin!.latestVersion!.audit!.findings.length).toBeGreaterThan(0);
  });

  it("returns null for nonexistent plugin", async () => {
    const plugin = await getPluginDetail(env.DB, "nonexistent-plugin-id");
    expect(plugin).toBeNull();
  });

  it("returns null for plugin with no published versions", async () => {
    // security-headers only has a pending version — should be hidden from public
    const plugin = await getPluginDetail(env.DB, "security-headers");
    expect(plugin).toBeNull();
  });

  it("shows flagged version as latest when most recent", async () => {
    // analytics-pro has v1.0.0 (published) and v1.0.1 (flagged)
    const plugin = await getPluginDetail(env.DB, "analytics-pro");

    expect(plugin).not.toBeNull();
    expect(plugin!.latestVersion).not.toBeNull();
    expect(plugin!.latestVersion!.version).toBe("1.0.1");
    expect(plugin!.latestVersion!.status).toBe("flagged");
    expect(plugin!.latestVersion!.audit).not.toBeNull();
    expect(plugin!.latestVersion!.audit!.verdict).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// DISC-03: Plugin Version History
// ---------------------------------------------------------------------------

describe("Plugin Version History (DISC-03)", () => {
  it("returns version summaries ordered by created_at DESC", async () => {
    const versions = await getPluginVersions(env.DB, "seo-toolkit");

    expect(versions.length).toBe(3);
    // Most recent first
    expect(versions[0].version).toBe("2.0.0-beta");
    expect(versions[1].version).toBe("1.1.0");
    expect(versions[2].version).toBe("1.0.0");
  });

  it("includes correct version fields", async () => {
    const versions = await getPluginVersions(env.DB, "seo-toolkit");
    const v110 = versions.find((v) => v.version === "1.1.0");

    expect(v110).toBeDefined();
    expect(typeof v110!.version).toBe("string");
    expect(typeof v110!.minEmDashVersion).toBe("string");
    expect(typeof v110!.bundleSize).toBe("number");
    expect(typeof v110!.checksum).toBe("string");
    expect(typeof v110!.changelog).toBe("string");
    expect(Array.isArray(v110!.capabilities)).toBe(true);
    expect(v110!.capabilities).toContain("content:write");
    expect(v110!.status).toBe("published");
    expect(typeof v110!.publishedAt).toBe("string");
  });

  it("includes audit verdict and risk score from joined audit data", async () => {
    const versions = await getPluginVersions(env.DB, "seo-toolkit");

    // v1.0.0 has audit verdict "pass"
    const v100 = versions.find((v) => v.version === "1.0.0");
    expect(v100).toBeDefined();
    expect(v100!.auditVerdict).toBe("pass");

    // v1.1.0 has audit verdict "pass"
    const v110 = versions.find((v) => v.version === "1.1.0");
    expect(v110).toBeDefined();
    expect(v110!.auditVerdict).toBe("pass");

    // v2.0.0-beta has no audit (pending)
    const vBeta = versions.find((v) => v.version === "2.0.0-beta");
    expect(vBeta).toBeDefined();
    expect(vBeta!.auditVerdict).toBeNull();
  });

  it("returns empty array for plugin with no versions", async () => {
    const versions = await getPluginVersions(env.DB, "totally-fake-plugin");
    expect(versions).toEqual([]);
  });

  it("shows warn and fail verdicts correctly", async () => {
    // analytics-pro v1.0.1 is flagged with "warn" verdict
    const analyticsVersions = await getPluginVersions(
      env.DB,
      "analytics-pro",
    );
    const flagged = analyticsVersions.find((v) => v.version === "1.0.1");
    expect(flagged).toBeDefined();
    expect(flagged!.auditVerdict).toBe("warn");

    // social-share v0.9.0 is rejected with "fail" verdict
    const socialVersions = await getPluginVersions(env.DB, "social-share");
    const rejected = socialVersions.find((v) => v.version === "0.9.0");
    expect(rejected).toBeDefined();
    expect(rejected!.auditVerdict).toBe("fail");
  });
});
