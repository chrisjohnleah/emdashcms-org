/**
 * Integration tests for /sitemap.xml (AIDX-08).
 *
 * The vitest-pool-workers runtime exposes the same env binding under
 * `cloudflare:test` as the page imports under `cloudflare:workers`, so
 * we can import the route's `GET` handler directly and drive it with
 * a synthetic Request — no HTTP fetch, no Astro renderer needed.
 *
 * Each test seeds D1 deterministically in `beforeEach`, invokes the
 * handler, and parses the returned XML body via regex / substring.
 * We deliberately keep the parser dumb: if the endpoint ever starts
 * emitting malformed XML, the well-formedness test below catches it.
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { GET } from "../../src/pages/sitemap.xml";
// Vite ?raw lets us assert against robots.txt inside the Workers
// isolate without a host readFileSync.
import robotsTxtSource from "../../public/robots.txt?raw";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // One shared author for every seeded row. Plan 03 does not exercise
  // author metadata — the sitemap only emits the author-agnostic URL
  // shape `/plugins/{id}` and `/themes/{id}`.
  await env.DB.prepare("DELETE FROM installs").run().catch(() => {});
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);
  await env.DB.prepare(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('sitemap-author', 9001, 'sitemap-tester', NULL, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
});

async function clearCatalog() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
  ]);
}

async function seedPlugin(opts: {
  id: string;
  category?: string | null;
  updatedAt: string;
  versionStatus?: "published" | "flagged" | "pending" | "rejected";
  status?: "active" | "revoked";
}): Promise<void> {
  const {
    id,
    category = null,
    updatedAt,
    versionStatus = "published",
    status = "active",
  } = opts;

  await env.DB.prepare(
    "INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, license, installs_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "sitemap-author",
      `Plugin ${id}`,
      null,
      category,
      "[]",
      "[]",
      "MIT",
      0,
      status,
      "2026-01-01T00:00:00Z",
      updatedAt,
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, checksum, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `pv-${id}`,
      id,
      "1.0.0",
      versionStatus,
      `bundles/${id}/1.0.0.tar.gz`,
      `{"id":"${id}","version":"1.0.0","capabilities":[],"allowedHosts":[],"storage":null,"hooks":[],"routes":[],"admin":null}`,
      1,
      1000,
      2000,
      "sha256:" + "a".repeat(8),
      versionStatus === "published" ? "2026-01-02T00:00:00Z" : null,
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    )
    .run();
}

async function seedTheme(opts: {
  id: string;
  category?: string | null;
  updatedAt: string;
  installable?: boolean;
}): Promise<void> {
  const { id, category = null, updatedAt, installable = true } = opts;
  await env.DB.prepare(
    "INSERT INTO themes (id, author_id, name, description, category, keywords, repository_url, npm_package, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "sitemap-author",
      `Theme ${id}`,
      null,
      category,
      "[]",
      installable ? `https://example.com/${id}` : null,
      null,
      "2026-01-01T00:00:00Z",
      updatedAt,
    )
    .run();
}

function makeRequest(): Request {
  return new Request("https://emdashcms.org/sitemap.xml", { method: "GET" });
}

async function invoke(): Promise<Response> {
  return (GET as unknown as (ctx: { request: Request }) => Promise<Response>)({
    request: makeRequest(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const STATIC_LOCS = [
  "https://emdashcms.org/",
  "https://emdashcms.org/plugins",
  "https://emdashcms.org/themes",
  "https://emdashcms.org/digest",
  "https://emdashcms.org/learn",
  "https://emdashcms.org/learn/what-is-emdash",
  "https://emdashcms.org/learn/plugin-system",
  "https://emdashcms.org/learn/manifest-schema",
  "https://emdashcms.org/learn/capabilities",
  "https://emdashcms.org/compare",
  "https://emdashcms.org/compare/emdash-vs-wordpress",
  "https://emdashcms.org/guide",
  "https://emdashcms.org/docs/contributors",
  "https://emdashcms.org/docs/moderators",
  "https://emdashcms.org/docs/security",
  "https://emdashcms.org/privacy",
  "https://emdashcms.org/terms",
  "https://emdashcms.org/code-of-conduct",
];

describe("/sitemap.xml endpoint", () => {
  beforeEach(async () => {
    await clearCatalog();
  });

  it("returns 200 with the correct Content-Type and Cache-Control headers", async () => {
    const res = await invoke();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/xml; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, s-maxage=3600",
    );
  });

  it("emits every static URL and no plugin detail URLs when the catalog is empty", async () => {
    const body = await (await invoke()).text();
    for (const loc of STATIC_LOCS) {
      expect(body).toContain(`<loc>${loc}</loc>`);
    }
    // No plugin or theme detail URLs beyond the /plugins and /themes
    // index pages (which ARE in STATIC_LOCS).
    expect(body).not.toMatch(/<loc>https:\/\/emdashcms\.org\/plugins\/[^<]+<\/loc>/);
    expect(body).not.toMatch(/<loc>https:\/\/emdashcms\.org\/themes\/[^<]+<\/loc>/);
    expect(body).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(body).toContain("<urlset ");
    expect(body).toContain("</urlset>");
  });

  it("includes every published plugin with the correct <loc> and <lastmod>", async () => {
    await seedPlugin({
      id: "plugin-one",
      category: "editor",
      updatedAt: "2026-03-01T10:00:00Z",
    });
    await seedPlugin({
      id: "plugin-two",
      category: "editor",
      updatedAt: "2026-03-02T10:00:00Z",
    });
    await seedPlugin({
      id: "plugin-three",
      category: null,
      updatedAt: "2026-03-03T10:00:00Z",
    });

    const body = await (await invoke()).text();

    expect(body).toContain("<loc>https://emdashcms.org/plugins/plugin-one</loc>");
    expect(body).toContain("<loc>https://emdashcms.org/plugins/plugin-two</loc>");
    expect(body).toContain(
      "<loc>https://emdashcms.org/plugins/plugin-three</loc>",
    );
    expect(body).toContain("<lastmod>2026-03-01T10:00:00Z</lastmod>");
    expect(body).toContain("<lastmod>2026-03-02T10:00:00Z</lastmod>");
    expect(body).toContain("<lastmod>2026-03-03T10:00:00Z</lastmod>");
  });

  it("excludes plugins whose only version is not published (status !== 'published' and !== 'flagged')", async () => {
    await seedPlugin({
      id: "visible",
      updatedAt: "2026-03-01T10:00:00Z",
      versionStatus: "published",
    });
    await seedPlugin({
      id: "pending-only",
      updatedAt: "2026-03-02T10:00:00Z",
      versionStatus: "pending",
    });
    await seedPlugin({
      id: "rejected-only",
      updatedAt: "2026-03-03T10:00:00Z",
      versionStatus: "rejected",
    });

    const body = await (await invoke()).text();

    expect(body).toContain("<loc>https://emdashcms.org/plugins/visible</loc>");
    expect(body).not.toContain(
      "<loc>https://emdashcms.org/plugins/pending-only</loc>",
    );
    expect(body).not.toContain(
      "<loc>https://emdashcms.org/plugins/rejected-only</loc>",
    );
  });

  it("excludes plugins whose parent row has been revoked", async () => {
    await seedPlugin({
      id: "revoked-plugin",
      updatedAt: "2026-03-10T10:00:00Z",
      versionStatus: "published",
      status: "revoked",
    });

    const body = await (await invoke()).text();
    expect(body).not.toContain(
      "<loc>https://emdashcms.org/plugins/revoked-plugin</loc>",
    );
  });

  it("includes every installable theme with the correct <loc> and <lastmod>", async () => {
    await seedTheme({
      id: "theme-one",
      category: "documentation",
      updatedAt: "2026-03-04T10:00:00Z",
    });
    await seedTheme({
      id: "theme-two",
      category: null,
      updatedAt: "2026-03-05T10:00:00Z",
    });

    const body = await (await invoke()).text();
    expect(body).toContain("<loc>https://emdashcms.org/themes/theme-one</loc>");
    expect(body).toContain("<loc>https://emdashcms.org/themes/theme-two</loc>");
    expect(body).toContain("<lastmod>2026-03-04T10:00:00Z</lastmod>");
    expect(body).toContain("<lastmod>2026-03-05T10:00:00Z</lastmod>");
  });

  it("excludes themes with no repository_url and no npm_package (not installable)", async () => {
    await seedTheme({
      id: "not-installable",
      updatedAt: "2026-03-06T10:00:00Z",
      installable: false,
    });
    const body = await (await invoke()).text();
    expect(body).not.toContain(
      "<loc>https://emdashcms.org/themes/not-installable</loc>",
    );
  });

  it("emits one /plugins/category/{slug} entry per DISTINCT non-null category with MAX(updated_at)", async () => {
    // Two plugins in 'editor' — the later updated_at wins as lastmod.
    await seedPlugin({
      id: "editor-early",
      category: "editor",
      updatedAt: "2026-03-01T10:00:00Z",
    });
    await seedPlugin({
      id: "editor-late",
      category: "editor",
      updatedAt: "2026-03-20T10:00:00Z",
    });
    await seedPlugin({
      id: "publish-only",
      category: "publishing",
      updatedAt: "2026-03-10T10:00:00Z",
    });
    // A null-category plugin must not produce a category URL.
    await seedPlugin({
      id: "uncat",
      category: null,
      updatedAt: "2026-03-15T10:00:00Z",
    });

    const body = await (await invoke()).text();

    // Exactly one entry per category.
    const editorMatches = body.match(
      /<loc>https:\/\/emdashcms\.org\/plugins\/category\/editor<\/loc>/g,
    );
    expect(editorMatches?.length).toBe(1);
    const publishingMatches = body.match(
      /<loc>https:\/\/emdashcms\.org\/plugins\/category\/publishing<\/loc>/g,
    );
    expect(publishingMatches?.length).toBe(1);

    // No null-category slug emitted.
    expect(body).not.toContain(
      "<loc>https://emdashcms.org/plugins/category/</loc>",
    );
    expect(body).not.toContain("<loc>https://emdashcms.org/plugins/category/null</loc>");

    // MAX(updated_at) lastmod on the editor category.
    const editorUrlBlock = body.match(
      /<url>\s*<loc>https:\/\/emdashcms\.org\/plugins\/category\/editor<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/,
    );
    expect(editorUrlBlock).not.toBeNull();
    expect(editorUrlBlock?.[1]).toBe("2026-03-20T10:00:00Z");
  });

  it("emits one /themes/category/{slug} entry per DISTINCT non-null category with MAX(updated_at)", async () => {
    await seedTheme({
      id: "doc-early",
      category: "documentation",
      updatedAt: "2026-03-04T10:00:00Z",
    });
    await seedTheme({
      id: "doc-late",
      category: "documentation",
      updatedAt: "2026-04-01T10:00:00Z",
    });
    await seedTheme({
      id: "blog-one",
      category: "blog",
      updatedAt: "2026-03-15T10:00:00Z",
    });
    await seedTheme({
      id: "no-cat",
      category: null,
      updatedAt: "2026-03-20T10:00:00Z",
    });

    const body = await (await invoke()).text();
    const docMatches = body.match(
      /<loc>https:\/\/emdashcms\.org\/themes\/category\/documentation<\/loc>/g,
    );
    expect(docMatches?.length).toBe(1);
    const blogMatches = body.match(
      /<loc>https:\/\/emdashcms\.org\/themes\/category\/blog<\/loc>/g,
    );
    expect(blogMatches?.length).toBe(1);
    expect(body).not.toContain(
      "<loc>https://emdashcms.org/themes/category/</loc>",
    );

    const docBlock = body.match(
      /<url>\s*<loc>https:\/\/emdashcms\.org\/themes\/category\/documentation<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/,
    );
    expect(docBlock?.[1]).toBe("2026-04-01T10:00:00Z");
  });

  it("XML-escapes ampersands in plugin ids so the sitemap survives defensive input", async () => {
    await seedPlugin({
      id: "foo&bar",
      updatedAt: "2026-03-30T10:00:00Z",
    });
    const body = await (await invoke()).text();
    expect(body).toContain(
      "<loc>https://emdashcms.org/plugins/foo&amp;bar</loc>",
    );
    // Raw ampersand must never appear inside a <loc>.
    expect(body).not.toMatch(
      /<loc>https:\/\/emdashcms\.org\/plugins\/foo&bar<\/loc>/,
    );
    // Well-formedness: every <url> has a matching </url>.
    const openCount = (body.match(/<url>/g) ?? []).length;
    const closeCount = (body.match(/<\/url>/g) ?? []).length;
    expect(openCount).toBe(closeCount);
  });

  it("emits <lastmod> values in ISO 8601 datetime format", async () => {
    await seedPlugin({
      id: "fmt-check",
      updatedAt: "2026-03-11T14:30:00Z",
    });
    const body = await (await invoke()).text();
    const lastmodValues = [
      ...body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g),
    ].map((m) => m[1]);
    expect(lastmodValues.length).toBeGreaterThan(0);
    for (const value of lastmodValues) {
      expect(value).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
      );
    }
  });

  it("public/robots.txt references the sitemap (AIDX-08 verify-only)", () => {
    // Asserts the existing directive; the test never modifies the
    // file. Fails loudly if someone edits public/robots.txt and drops
    // the line.
    expect(robotsTxtSource).toContain(
      "Sitemap: https://emdashcms.org/sitemap.xml",
    );
  });

  it("does NOT emit hook browse URLs or per-digest URLs (no such routes exist today)", async () => {
    // Seed enough data that the sitemap is not trivially empty.
    await seedPlugin({
      id: "coverage",
      category: "editor",
      updatedAt: "2026-03-01T10:00:00Z",
    });
    await seedTheme({
      id: "coverage-theme",
      category: "documentation",
      updatedAt: "2026-03-01T10:00:00Z",
    });

    const body = await (await invoke()).text();
    // /digest (the archive index) IS emitted as a static entry; per-digest slug
    // URLs (/digest/2026-W17) are not — enumerating them would require a D1
    // scan of weekly_digests that the sitemap builder does not perform today.
    expect(body).not.toMatch(/\/digest\/\d{4}-W\d{2}/);
    // No /hook/* routes exist in src/pages/.
    expect(body).not.toContain("/hook");
  });
});
