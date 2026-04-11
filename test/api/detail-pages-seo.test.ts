/**
 * Integration tests for Phase 16 Plan 01 — plugin, theme, and
 * homepage SEO structured data.
 *
 * The vitest-pool-workers harness cannot render Astro `.astro` files
 * (no virtual modules, no Vite pipeline), so these tests don't go
 * through HTTP. Instead they:
 *
 *   1. Seed real D1 rows through the same query layer the detail
 *      pages use.
 *   2. Feed the results into the JSON-LD builders exactly as the
 *      detail-page frontmatter does.
 *   3. Apply BaseLayout's injection-defense escape on the stringified
 *      payload and assert the output round-trips through JSON.parse.
 *   4. Read the BaseLayout source from disk to assert the critical
 *      wiring (Props interface, `set:html` emission, and the `</script>`
 *      escape) is actually present, so the handler-level assertions
 *      are only meaningful when the Astro glue is wired correctly.
 *
 * Together these cover the full AIDX-02/03/04 success criteria
 * without requiring an HTTP renderer.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
// Vite `?raw` import gets the BaseLayout source as a string, avoiding
// fs access from the Workers runtime (which can't read host files).
// @ts-expect-error — Vite virtual module, no types
import baseLayoutSource from "../../src/layouts/BaseLayout.astro?raw";
import {
  getPluginDetail,
  getPluginVersions,
  getThemeDetail,
} from "../../src/lib/db/queries";
import {
  getReviewStats,
  createReview,
} from "../../src/lib/db/review-queries";
import {
  buildPluginJsonLd,
  buildThemeJsonLd,
  buildOrganizationJsonLd,
} from "../../src/lib/seo/json-ld";

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const INJECTION = "</script><script>alert(1)</script>";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "author-seo",
        9001,
        "alice-dev",
        "https://avatars.githubusercontent.com/u/9001",
        1,
        "2026-01-10T08:00:00Z",
        "2026-03-20T12:00:00Z",
      ),
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "reviewer-1",
        9101,
        "reviewer-one",
        null,
        0,
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
      ),
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "reviewer-2",
        9102,
        "reviewer-two",
        null,
        0,
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
      ),
    env.DB
      .prepare(
        "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "reviewer-3",
        9103,
        "reviewer-three",
        null,
        0,
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
      ),
  ]);

  // Plugins: one clean, one rated, one with an injection-attack description
  const pluginSql =
    "INSERT INTO plugins (id, author_id, name, short_description, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB
      .prepare(pluginSql)
      .bind(
        "seo-clean",
        "author-seo",
        "SEO Clean",
        "Structured data for EmDash.",
        "Long-form description.",
        "content",
        '["content:write"]',
        '["seo","meta"]',
        "https://github.com/alice-dev/seo-clean",
        null,
        null,
        "MIT",
        100,
        "2026-01-15T10:00:00Z",
        "2026-03-20T12:00:00Z",
      ),
    env.DB
      .prepare(pluginSql)
      .bind(
        "seo-rated",
        "author-seo",
        "SEO Rated",
        "A plugin with reviews for aggregateRating coverage.",
        null,
        "content",
        "[]",
        "[]",
        null,
        null,
        null,
        null,
        200,
        "2026-01-20T10:00:00Z",
        "2026-03-22T12:00:00Z",
      ),
    env.DB
      .prepare(pluginSql)
      .bind(
        "seo-injection",
        "author-seo",
        "SEO Injection",
        INJECTION,
        null,
        "content",
        "[]",
        "[]",
        null,
        null,
        null,
        null,
        10,
        "2026-02-01T10:00:00Z",
        "2026-03-10T12:00:00Z",
      ),
  ]);

  // One published version per plugin so getPluginDetail returns them
  const versionSql =
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  await env.DB.batch([
    env.DB
      .prepare(versionSql)
      .bind(
        "pv-seo-clean-1",
        "seo-clean",
        "1.0.0",
        "published",
        "bundles/seo-clean/1.0.0.tar.gz",
        '{"id":"seo-clean","version":"1.0.0","capabilities":["content:write"],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}',
        5,
        20000,
        50000,
        "1.0.0",
        "sha256:a".repeat(8),
        null,
        null,
        "2026-01-15T12:00:00Z",
        "2026-01-15T10:00:00Z",
        "2026-01-15T12:00:00Z",
      ),
    env.DB
      .prepare(versionSql)
      .bind(
        "pv-seo-rated-1",
        "seo-rated",
        "1.0.0",
        "published",
        "bundles/seo-rated/1.0.0.tar.gz",
        '{"id":"seo-rated","version":"1.0.0","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}',
        3,
        10000,
        25000,
        null,
        "sha256:b".repeat(8),
        null,
        null,
        "2026-01-20T12:00:00Z",
        "2026-01-20T10:00:00Z",
        "2026-01-20T12:00:00Z",
      ),
    env.DB
      .prepare(versionSql)
      .bind(
        "pv-seo-injection-1",
        "seo-injection",
        "1.0.0",
        "published",
        "bundles/seo-injection/1.0.0.tar.gz",
        '{"id":"seo-injection","version":"1.0.0","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}',
        2,
        5000,
        10000,
        null,
        "sha256:c".repeat(8),
        null,
        null,
        "2026-02-01T12:00:00Z",
        "2026-02-01T10:00:00Z",
        "2026-02-01T12:00:00Z",
      ),
  ]);

  // Themes
  await env.DB.exec(
    "INSERT INTO themes (id, author_id, name, short_description, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES ('seo-theme', 'author-seo', 'SEO Theme', 'A test theme for structured data', 'Full theme description.', '[\"minimal\",\"editorial\"]', 'https://github.com/alice-dev/seo-theme', NULL, NULL, '@emdash-themes/seo-theme', NULL, NULL, 'MIT', '2026-01-15T10:00:00Z', '2026-03-20T12:00:00Z');",
  );

  // Seed 3 reviews on seo-rated: [5, 4, 3] → average 4
  await createReview(env.DB, "plugin", "seo-rated", "reviewer-1", 5, "Excellent plugin, works perfectly.");
  await createReview(env.DB, "plugin", "seo-rated", "reviewer-2", 4, "Good plugin, works as described.");
  await createReview(env.DB, "plugin", "seo-rated", "reviewer-3", 3, "Works OK, has some rough edges.");
});

// ---------------------------------------------------------------------------
// Helper: the exact escape BaseLayout applies before emitting
// ---------------------------------------------------------------------------

function emitJsonLd(obj: object): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Plugin detail JSON-LD
// ---------------------------------------------------------------------------

describe("plugin detail JSON-LD", () => {
  it("builds a SoftwareApplication payload matching visible content and omits aggregateRating with zero reviews", async () => {
    const plugin = await getPluginDetail(env.DB, "seo-clean");
    expect(plugin).not.toBeNull();

    const versions = await getPluginVersions(env.DB, "seo-clean");
    expect(versions.length).toBeGreaterThan(0);

    const stats = await getReviewStats(env.DB, "plugin", "seo-clean");
    expect(stats.totalCount).toBe(0);

    const latestVersionForJsonLd = versions[0]
      ? {
          version: versions[0].version,
          published_at: versions[0].publishedAt ?? null,
          created_at: versions[0].publishedAt ?? plugin!.updatedAt,
        }
      : null;

    const result = buildPluginJsonLd(plugin!, latestVersionForJsonLd, stats);

    expect(result["@type"]).toBe("SoftwareApplication");
    expect(result.name).toBe(plugin!.name);
    expect(result.description).toBe("Structured data for EmDash.");
    expect("aggregateRating" in result).toBe(false);

    // Parse the emitted form to prove the payload round-trips
    const emitted = emitJsonLd(result);
    const parsed = JSON.parse(emitted) as Record<string, unknown>;
    expect(parsed["@type"]).toBe("SoftwareApplication");
    expect(parsed.name).toBe(plugin!.name);
  });

  it("includes aggregateRating with the correct average and count when reviews exist", async () => {
    const plugin = await getPluginDetail(env.DB, "seo-rated");
    expect(plugin).not.toBeNull();

    const versions = await getPluginVersions(env.DB, "seo-rated");
    const stats = await getReviewStats(env.DB, "plugin", "seo-rated");

    expect(stats.totalCount).toBe(3);
    // [5, 4, 3] → 4.0
    expect(stats.averageRating).toBe(4);

    const latestVersionForJsonLd = versions[0]
      ? {
          version: versions[0].version,
          published_at: versions[0].publishedAt ?? null,
          created_at: versions[0].publishedAt ?? plugin!.updatedAt,
        }
      : null;

    const result = buildPluginJsonLd(plugin!, latestVersionForJsonLd, stats);
    expect(result.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4,
      reviewCount: 3,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("escapes </script> in plugin descriptions so the payload cannot break out of the <script> block", async () => {
    const plugin = await getPluginDetail(env.DB, "seo-injection");
    expect(plugin).not.toBeNull();
    expect(plugin!.shortDescription).toBe(INJECTION);

    const versions = await getPluginVersions(env.DB, "seo-injection");
    const stats = await getReviewStats(env.DB, "plugin", "seo-injection");

    const latestVersionForJsonLd = {
      version: versions[0].version,
      published_at: versions[0].publishedAt ?? null,
      created_at: versions[0].publishedAt ?? plugin!.updatedAt,
    };

    const result = buildPluginJsonLd(plugin!, latestVersionForJsonLd, stats);

    // The BUILDER stores the raw string — escaping is the emission layer
    expect(result.description).toBe(INJECTION);

    // The EMITTER must rewrite every `<` as \u003c so the literal
    // `</script>` never appears in the final HTML chunk. `>` is left
    // alone — the HTML parser only looks for `</` to terminate a
    // <script> block, so escaping `<` is both necessary and sufficient.
    const emitted = emitJsonLd(result);
    expect(emitted).not.toContain("</script>");
    expect(emitted).not.toContain("<script>");
    expect(emitted).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");

    // And the payload must still round-trip cleanly
    const parsed = JSON.parse(emitted) as Record<string, unknown>;
    expect(parsed.description).toBe(INJECTION);
  });
});

// ---------------------------------------------------------------------------
// Theme detail JSON-LD
// ---------------------------------------------------------------------------

describe("theme detail JSON-LD", () => {
  it("builds a CreativeWork payload matching visible content", async () => {
    const theme = await getThemeDetail(env.DB, "seo-theme");
    expect(theme).not.toBeNull();

    const stats = await getReviewStats(env.DB, "theme", "seo-theme");
    const result = buildThemeJsonLd(theme!, stats);

    expect(result["@type"]).toBe("CreativeWork");
    expect(result.name).toBe("SEO Theme");
    expect(result.description).toBe("A test theme for structured data");
    expect(result.url).toBe("https://emdashcms.org/themes/seo-theme");
    expect(result.keywords).toBe("minimal, editorial");
    expect(result.dateModified).toBe("2026-03-20T12:00:00Z");
    // No screenshots on seed → falls back to /og/theme/{id}.png
    expect(result.image).toBe(
      "https://emdashcms.org/og/theme/seo-theme.png",
    );
    expect("aggregateRating" in result).toBe(false);

    // Round-trip through the emission layer
    const parsed = JSON.parse(emitJsonLd(result)) as Record<string, unknown>;
    expect(parsed["@type"]).toBe("CreativeWork");
  });
});

// ---------------------------------------------------------------------------
// Homepage Organization JSON-LD
// ---------------------------------------------------------------------------

describe("homepage Organization JSON-LD", () => {
  it("builds an Organization payload pointing at the marketplace repo", () => {
    const result = buildOrganizationJsonLd();
    expect(result["@type"]).toBe("Organization");
    expect(result.name).toBe("EmDash CMS Marketplace");
    expect(result.url).toBe("https://emdashcms.org");
    expect(result.sameAs).toEqual([
      "https://github.com/chrisjohnleah/emdashcms-org",
    ]);

    const parsed = JSON.parse(emitJsonLd(result)) as Record<string, unknown>;
    expect(parsed.sameAs).toEqual([
      "https://github.com/chrisjohnleah/emdashcms-org",
    ]);
  });
});

// ---------------------------------------------------------------------------
// BaseLayout static wiring
// ---------------------------------------------------------------------------
//
// These tests read BaseLayout.astro from disk and assert the critical
// hooks (Props interface, jsonLdArray normalisation, set:html emission,
// and the injection-defense escape) are wired. They exist because the
// pool-workers runtime cannot render Astro pages, so the only way to
// catch a regression where someone removes the `<` escape is to grep
// the source. `readFileSync` works inside the Workers runtime because
// vitest-pool-workers runs the host's Node fs module.

describe("BaseLayout static wiring", () => {
  const baseLayoutSrc = baseLayoutSource as string;

  it("exposes jsonLd?: object | object[] on Props", () => {
    expect(baseLayoutSrc).toContain("jsonLd?: object | object[]");
  });

  it("exposes ogImage? on Props (Plan 02 will set it)", () => {
    expect(baseLayoutSrc).toContain(
      "ogImage?: { url: string; width?: number; height?: number }",
    );
  });

  it("emits ld+json blocks with set:html and applies the </script> escape", () => {
    expect(baseLayoutSrc).toContain("application/ld+json");
    expect(baseLayoutSrc).toContain("set:html={safe}");
    // The source contains the literal 7 bytes `\\u003c` so we match the
    // same sequence here — double the backslashes in the TS string.
    expect(baseLayoutSrc).toContain("replace(/</g, '\\\\u003c')");
  });

  it("switches twitter:card to summary_large_image when ogImage is present", () => {
    expect(baseLayoutSrc).toContain("summary_large_image");
  });

  it("gates og:image meta on the ogImage prop", () => {
    expect(baseLayoutSrc).toMatch(/ogImage\s*&&[\s\S]*og:image/);
  });
});
