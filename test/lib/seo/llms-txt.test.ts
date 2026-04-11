import { describe, it, expect } from "vitest";
import { buildLlmsTxt } from "../../../src/lib/seo/llms-txt";
import type {
  MarketplacePluginSummary,
  MarketplaceThemeSummary,
} from "../../../src/types/marketplace";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlugin(
  overrides: Partial<MarketplacePluginSummary> = {},
): MarketplacePluginSummary {
  return {
    id: "my-plugin",
    name: "My Plugin",
    shortDescription: "does stuff",
    description: "Longer description.",
    author: { name: "alice", verified: true, avatarUrl: null },
    capabilities: [],
    keywords: [],
    installCount: 100,
    downloadCount: 200,
    hasIcon: false,
    iconUrl: null,
    latestVersion: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function makeTheme(
  overrides: Partial<MarketplaceThemeSummary> = {},
): MarketplaceThemeSummary {
  return {
    id: "my-theme",
    name: "My Theme",
    shortDescription: "cool theme",
    description: null,
    author: { name: "carol", verified: true, avatarUrl: null },
    keywords: [],
    previewUrl: null,
    demoUrl: null,
    hasThumbnail: false,
    thumbnailUrl: null,
    downloadCount: 50,
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLlmsTxt", () => {
  it("emits a spec-compliant header, blockquote summary, and all three H2 sections when populated", () => {
    const result = buildLlmsTxt({
      featured: [
        makePlugin({ id: "p1", name: "Plugin One", shortDescription: "A one-line desc" }),
      ],
      recentlyUpdated: [
        makePlugin({ id: "p2", name: "Plugin Two", shortDescription: "another" }),
      ],
      themes: [makeTheme({ id: "t1", name: "Theme One", shortDescription: "nice" })],
    });

    expect(result.startsWith("# EmDash CMS Marketplace\n\n> ")).toBe(true);
    expect(result).toContain("## Featured Plugins");
    expect(result).toContain("## Recently Updated Plugins");
    expect(result).toContain("## Themes");
    expect(result).toContain("## API");
  });

  it("omits H2 sections entirely when the corresponding arrays are empty", () => {
    const result = buildLlmsTxt({
      featured: [],
      recentlyUpdated: [],
      themes: [],
    });

    expect(result).toContain("# EmDash CMS Marketplace");
    expect(result).toContain("\n> ");
    expect(result).toContain("## API");
    expect(result).not.toContain("## Featured Plugins");
    expect(result).not.toContain("## Recently Updated Plugins");
    expect(result).not.toContain("## Themes");
  });

  it("formats a plugin bullet with the canonical link shape", () => {
    const result = buildLlmsTxt({
      featured: [
        makePlugin({
          id: "my-plugin",
          name: "My Plugin",
          shortDescription: "does stuff",
        }),
      ],
      recentlyUpdated: [],
      themes: [],
    });

    expect(result).toContain(
      "- [My Plugin](https://emdashcms.org/plugins/my-plugin): does stuff",
    );
  });

  it("falls back to the plugin name when both descriptions are null", () => {
    const result = buildLlmsTxt({
      featured: [
        makePlugin({
          id: "x",
          name: "X",
          shortDescription: null,
          description: null,
        }),
      ],
      recentlyUpdated: [],
      themes: [],
    });

    expect(result).toContain("- [X](https://emdashcms.org/plugins/x): X");
  });

  it("falls back to description when shortDescription is null", () => {
    const result = buildLlmsTxt({
      featured: [
        makePlugin({
          id: "p",
          name: "P",
          shortDescription: null,
          description: "Long prose description here.",
        }),
      ],
      recentlyUpdated: [],
      themes: [],
    });

    expect(result).toContain("- [P](https://emdashcms.org/plugins/p): Long prose description here.");
  });

  it("hard-caps each section at 25 bullets even when given more", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      makePlugin({ id: `p${i}`, name: `Plugin ${i}`, shortDescription: `desc ${i}` }),
    );
    const result = buildLlmsTxt({
      featured: many,
      recentlyUpdated: [],
      themes: [],
    });

    const featuredSection = result.split("## Featured Plugins")[1]?.split("## ")[0] ?? "";
    const bullets = featuredSection.match(/^- \[/gm) ?? [];
    expect(bullets.length).toBe(25);
  });

  it("omits the ## Themes heading when themes array is empty but plugins exist", () => {
    const result = buildLlmsTxt({
      featured: [makePlugin()],
      recentlyUpdated: [],
      themes: [],
    });

    expect(result).toContain("## Featured Plugins");
    expect(result).not.toContain("## Themes");
  });

  it("strips newlines from descriptions so each bullet stays single-line", () => {
    const result = buildLlmsTxt({
      featured: [
        makePlugin({
          id: "nl",
          name: "NL",
          shortDescription: "line one\nline two\r\nline three",
        }),
      ],
      recentlyUpdated: [],
      themes: [],
    });

    expect(result).toContain("- [NL](https://emdashcms.org/plugins/nl): line one line two line three");
  });
});
