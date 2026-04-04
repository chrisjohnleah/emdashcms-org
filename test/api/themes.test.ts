import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { searchThemes, getThemeDetail } from "../../src/lib/db/queries";

beforeAll(async () => {
  // Insert authors (individual statements for D1 exec compatibility)
  await env.DB.exec(`
    INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('author-1', 1001, 'alice-dev', 'https://avatars.githubusercontent.com/u/1001', 1, '2026-01-10T08:00:00Z', '2026-03-20T12:00:00Z');
    INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('author-2', 1002, 'bob-plugins', 'https://avatars.githubusercontent.com/u/1002', 0, '2026-01-20T09:00:00Z', '2026-03-15T10:00:00Z');
    INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES ('author-3', 1003, 'carol-themes', 'https://avatars.githubusercontent.com/u/1003', 1, '2026-02-01T10:00:00Z', '2026-03-25T14:00:00Z');
    INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES ('minimal-blog', 'author-3', 'Minimal Blog', 'A clean, fast blog theme with excellent typography and reading experience.', '["blog","minimal"]', 'https://github.com/carol-themes/minimal-blog', NULL, 'themes/minimal-blog/thumbnail.png', '@emdash-themes/minimal-blog', NULL, NULL, 'MIT', '2026-02-01T10:00:00Z', '2026-03-20T08:00:00Z');
    INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES ('portfolio-starter', 'author-1', 'Portfolio Starter', 'Showcase your work with a beautiful portfolio layout and project galleries.', '["portfolio","creative"]', 'https://github.com/alice-dev/portfolio-starter', 'https://portfolio-demo.example.com', NULL, '@emdash-themes/portfolio-starter', NULL, 'https://portfolio-starter.example.com', 'MIT', '2026-02-10T12:00:00Z', '2026-03-15T14:00:00Z');
    INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES ('docs-theme', 'author-2', 'Docs Theme', 'Technical documentation theme with sidebar navigation and code highlighting.', '["documentation","technical"]', 'https://github.com/bob-plugins/docs-theme', NULL, NULL, NULL, NULL, NULL, 'Apache-2.0', '2026-02-20T09:00:00Z', '2026-03-10T11:00:00Z');
    INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES ('ecommerce-starter', 'author-1', 'E-Commerce Starter', 'A full-featured e-commerce theme with product listings and cart functionality.', '["ecommerce","shop"]', 'https://github.com/alice-dev/ecommerce-starter', NULL, 'themes/ecommerce-starter/thumbnail.png', '@emdash-themes/ecommerce-starter', 'https://ecommerce-preview.example.com', 'https://ecommerce-starter.example.com', 'MIT', '2026-03-01T14:00:00Z', '2026-03-25T16:00:00Z');
    INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at) VALUES ('dark-mode', 'author-3', 'Dark Mode', 'A modern dark theme with smooth transitions and excellent contrast ratios.', '["dark","modern"]', 'https://github.com/carol-themes/dark-mode', NULL, NULL, NULL, NULL, NULL, NULL, '2026-03-10T08:00:00Z', '2026-03-28T12:00:00Z');
  `);
});

// ---------------------------------------------------------------------------
// DISC-04: Theme Search
// ---------------------------------------------------------------------------

describe("Theme Search (DISC-04)", () => {
  it("returns items array and nextCursor", async () => {
    const result = await searchThemes(env.DB, {
      query: "",
      keyword: null,
      sort: "created",
      cursor: null,
      limit: 20,
    });
    expect(result.items).toBeInstanceOf(Array);
    expect(result.items.length).toBe(5);
    expect(result).toHaveProperty("nextCursor");
    expect(result.nextCursor).toBeNull();
  });

  it("filters by query text (case-insensitive)", async () => {
    const result = await searchThemes(env.DB, {
      query: "blog",
      keyword: null,
      sort: "created",
      cursor: null,
      limit: 20,
    });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(
      result.items.every(
        (t) =>
          t.name.toLowerCase().includes("blog") ||
          (t.description?.toLowerCase().includes("blog") ?? false),
      ),
    ).toBe(true);
  });

  it("filters by keyword using json_each", async () => {
    const result = await searchThemes(env.DB, {
      query: "",
      keyword: "portfolio",
      sort: "created",
      cursor: null,
      limit: 20,
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0].id).toBe("portfolio-starter");
  });

  it("sorts by name ascending", async () => {
    const result = await searchThemes(env.DB, {
      query: "",
      keyword: null,
      sort: "name",
      cursor: null,
      limit: 20,
    });
    const names = result.items.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("paginates with limit and cursor", async () => {
    const page1 = await searchThemes(env.DB, {
      query: "",
      keyword: null,
      sort: "name",
      cursor: null,
      limit: 2,
    });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await searchThemes(env.DB, {
      query: "",
      keyword: null,
      sort: "name",
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);

    // No duplicates between pages
    const page1Ids = new Set(page1.items.map((t) => t.id));
    expect(page2.items.every((t) => !page1Ids.has(t.id))).toBe(true);
  });

  it("returns empty items for no-match query", async () => {
    const result = await searchThemes(env.DB, {
      query: "nonexistent-xyz-12345",
      keyword: null,
      sort: "created",
      cursor: null,
      limit: 20,
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns correct MarketplaceThemeSummary shape", async () => {
    const result = await searchThemes(env.DB, {
      query: "",
      keyword: "blog",
      sort: "created",
      cursor: null,
      limit: 20,
    });
    expect(result.items.length).toBe(1);
    const theme = result.items[0];

    // Verify shape fields
    expect(typeof theme.id).toBe("string");
    expect(typeof theme.name).toBe("string");
    expect(typeof theme.description).toBe("string");
    expect(typeof theme.author.name).toBe("string");
    expect(typeof theme.author.verified).toBe("boolean");
    expect(Array.isArray(theme.keywords)).toBe(true);
    expect(typeof theme.hasThumbnail).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// DISC-05: Theme Detail
// ---------------------------------------------------------------------------

describe("Theme Detail (DISC-05)", () => {
  it("returns full theme detail with author", async () => {
    const theme = await getThemeDetail(env.DB, "minimal-blog");
    expect(theme).not.toBeNull();
    expect(theme!.id).toBe("minimal-blog");
    expect(theme!.name).toBe("Minimal Blog");
    expect(theme!.author.name).toBe("carol-themes");
    expect(theme!.author.verified).toBe(true);
    expect(theme!.keywords).toEqual(["blog", "minimal"]);
  });

  it("returns null for nonexistent theme", async () => {
    const theme = await getThemeDetail(env.DB, "nonexistent-theme-id");
    expect(theme).toBeNull();
  });

  it("includes screenshotUrls as empty array and screenshotCount as 0", async () => {
    const theme = await getThemeDetail(env.DB, "minimal-blog");
    expect(theme!.screenshotUrls).toEqual([]);
    expect(theme!.screenshotCount).toBe(0);
  });

  it("includes hasThumbnail derived from thumbnail_key", async () => {
    const withThumb = await getThemeDetail(env.DB, "minimal-blog");
    expect(withThumb!.hasThumbnail).toBe(true);

    const withoutThumb = await getThemeDetail(env.DB, "docs-theme");
    expect(withoutThumb!.hasThumbnail).toBe(false);
  });

  it("returns optional fields correctly", async () => {
    const theme = await getThemeDetail(env.DB, "ecommerce-starter");
    expect(theme!.previewUrl).toBe("https://ecommerce-preview.example.com");
    expect(theme!.homepageUrl).toBe("https://ecommerce-starter.example.com");
    expect(theme!.license).toBe("MIT");

    const nullTheme = await getThemeDetail(env.DB, "dark-mode");
    expect(nullTheme!.repositoryUrl).toBe(
      "https://github.com/carol-themes/dark-mode",
    );
    expect(nullTheme!.license).toBeNull();
  });

  it("returns author.verified as boolean, not integer", async () => {
    const verifiedTheme = await getThemeDetail(env.DB, "minimal-blog");
    expect(verifiedTheme!.author.verified).toBe(true);
    expect(typeof verifiedTheme!.author.verified).toBe("boolean");

    const unverifiedTheme = await getThemeDetail(env.DB, "docs-theme");
    expect(unverifiedTheme!.author.verified).toBe(false);
    expect(typeof unverifiedTheme!.author.verified).toBe("boolean");
  });

  it("returns keywords as parsed array, not JSON string", async () => {
    const theme = await getThemeDetail(env.DB, "portfolio-starter");
    expect(Array.isArray(theme!.keywords)).toBe(true);
    expect(theme!.keywords).toEqual(["portfolio", "creative"]);
    expect(typeof theme!.keywords).not.toBe("string");
  });

  it("includes demoUrl when present", async () => {
    const withDemo = await getThemeDetail(env.DB, "portfolio-starter");
    expect(withDemo!.demoUrl).toBe("https://portfolio-demo.example.com");

    const withoutDemo = await getThemeDetail(env.DB, "minimal-blog");
    expect(withoutDemo!.demoUrl).toBeNull();
  });
});
