import { describe, it, expect } from "vitest";
import {
  buildPluginJsonLd,
  buildThemeJsonLd,
  buildOrganizationJsonLd,
} from "../../../src/lib/seo/json-ld";
import type {
  MarketplacePluginDetail,
  MarketplaceThemeDetail,
} from "../../../src/types/marketplace";
import type { ReviewStats } from "../../../src/lib/db/review-queries";

// ---------------------------------------------------------------------------
// Fixtures — constructed in-memory, builders are pure so no D1 is needed.
// ---------------------------------------------------------------------------

function makePlugin(
  overrides: Partial<MarketplacePluginDetail> = {},
): MarketplacePluginDetail {
  return {
    id: "seo-toolkit",
    name: "SEO Toolkit",
    shortDescription: "Structured data, sitemaps, meta tags.",
    description: "Long-form description of the SEO toolkit plugin.",
    author: {
      name: "alice-dev",
      verified: true,
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    },
    capabilities: ["content:write"],
    keywords: ["seo", "sitemap", "meta"],
    installCount: 1200,
    downloadCount: 3000,
    hasIcon: false,
    iconUrl: null,
    latestVersion: {
      version: "1.2.0",
      bundleSize: 45000,
      checksum: "sha256:abc",
      changelog: null,
      readme: null,
      screenshots: [],
      capabilities: ["content:write"],
      status: "published",
      audit: null,
      imageAudit: null,
      releaseUrl: null,
      commitSha: null,
    },
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-03-20T12:00:00Z",
    category: "content",
    repositoryUrl: "https://github.com/alice-dev/seo-toolkit",
    homepageUrl: null,
    license: "MIT",
    pluginStatus: "active",
    ...overrides,
  };
}

function makeTheme(
  overrides: Partial<MarketplaceThemeDetail> & { updatedAt?: string } = {},
): MarketplaceThemeDetail & { updatedAt?: string } {
  return {
    id: "minimalist",
    name: "Minimalist",
    shortDescription: "Clean, editorial theme.",
    description: "Long-form theme description.",
    author: {
      name: "carol-themes",
      verified: true,
      avatarUrl: "https://avatars.githubusercontent.com/u/3",
    },
    keywords: ["minimal", "editorial", "serif"],
    previewUrl: "https://minimalist.example.com",
    demoUrl: null,
    hasThumbnail: false,
    thumbnailUrl: null,
    downloadCount: 200,
    category: "editorial",
    repositoryUrl: "https://github.com/carol-themes/minimalist",
    homepageUrl: null,
    license: "MIT",
    screenshotCount: 1,
    screenshotUrls: ["https://example.com/shot-1.png"],
    updatedAt: "2026-03-25T14:00:00Z",
    ...overrides,
  };
}

const LATEST_VERSION = {
  version: "1.2.0",
  published_at: "2026-02-10T14:00:00Z",
  created_at: "2026-02-10T12:00:00Z",
};

const NO_REVIEWS: ReviewStats = { averageRating: 0, totalCount: 0 };

// ---------------------------------------------------------------------------
// buildPluginJsonLd
// ---------------------------------------------------------------------------

describe("buildPluginJsonLd", () => {
  it("returns a full SoftwareApplication payload for a well-formed plugin", () => {
    const plugin = makePlugin();
    const result = buildPluginJsonLd(plugin, LATEST_VERSION, NO_REVIEWS);

    expect(result["@context"]).toBe("https://schema.org");
    expect(result["@type"]).toBe("SoftwareApplication");
    expect(result.name).toBe("SEO Toolkit");
    expect(result.description).toBe("Structured data, sitemaps, meta tags.");
    expect(result.url).toBe("https://emdashcms.org/plugins/seo-toolkit");
    expect(result.applicationCategory).toBe("DeveloperApplication");
    expect(result.operatingSystem).toBe("EmDash CMS");
    expect(result.softwareVersion).toBe("1.2.0");
    expect(result.author).toEqual({
      "@type": "Person",
      name: "alice-dev",
      url: "https://github.com/alice-dev",
    });
    expect(result.offers).toEqual({
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    });
    expect(result.downloadUrl).toBe(
      "https://emdashcms.org/api/v1/plugins/seo-toolkit/versions/1.2.0/bundle",
    );
    expect(result.datePublished).toBe("2026-02-10T14:00:00Z");
    expect(result.dateModified).toBe("2026-03-20T12:00:00Z");
    expect(result.keywords).toBe("seo, sitemap, meta");
  });

  it("omits aggregateRating when reviewStats.totalCount is 0", () => {
    const plugin = makePlugin();
    const result = buildPluginJsonLd(plugin, LATEST_VERSION, NO_REVIEWS);
    expect("aggregateRating" in result).toBe(false);
  });

  it("includes aggregateRating when reviewStats.totalCount > 0", () => {
    const plugin = makePlugin();
    const result = buildPluginJsonLd(plugin, LATEST_VERSION, {
      averageRating: 4.5,
      totalCount: 12,
    });
    expect(result.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.5,
      reviewCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("omits softwareVersion/downloadUrl/datePublished when latestVersion is null", () => {
    const plugin = makePlugin();
    const result = buildPluginJsonLd(plugin, null, NO_REVIEWS);
    expect("softwareVersion" in result).toBe(false);
    expect("downloadUrl" in result).toBe(false);
    expect("datePublished" in result).toBe(false);
  });

  it("coalesces datePublished to created_at when published_at is null", () => {
    const plugin = makePlugin();
    const result = buildPluginJsonLd(
      plugin,
      { version: "1.2.0", published_at: null, created_at: "2026-02-10T12:00:00Z" },
      NO_REVIEWS,
    );
    expect(result.datePublished).toBe("2026-02-10T12:00:00Z");
  });

  it("omits keywords when plugin.keywords is empty", () => {
    const plugin = makePlugin({ keywords: [] });
    const result = buildPluginJsonLd(plugin, LATEST_VERSION, NO_REVIEWS);
    expect("keywords" in result).toBe(false);
  });

  it("does NOT touch < characters in string fields (escape is emission's job)", () => {
    const plugin = makePlugin({
      shortDescription: "</script><script>alert(1)</script>",
    });
    const result = buildPluginJsonLd(plugin, LATEST_VERSION, NO_REVIEWS);
    expect(result.description).toBe("</script><script>alert(1)</script>");
  });

  it("falls back to description when shortDescription is null", () => {
    const plugin = makePlugin({ shortDescription: null });
    const result = buildPluginJsonLd(plugin, LATEST_VERSION, NO_REVIEWS);
    expect(result.description).toBe(
      "Long-form description of the SEO toolkit plugin.",
    );
  });
});

// ---------------------------------------------------------------------------
// buildThemeJsonLd
// ---------------------------------------------------------------------------

describe("buildThemeJsonLd", () => {
  it("returns a full CreativeWork payload for a well-formed theme", () => {
    const theme = makeTheme();
    const result = buildThemeJsonLd(theme, NO_REVIEWS);

    expect(result["@context"]).toBe("https://schema.org");
    expect(result["@type"]).toBe("CreativeWork");
    expect(result.name).toBe("Minimalist");
    expect(result.description).toBe("Clean, editorial theme.");
    expect(result.url).toBe("https://emdashcms.org/themes/minimalist");
    expect(result.author).toEqual({
      "@type": "Person",
      name: "carol-themes",
      url: "https://github.com/carol-themes",
    });
    expect(result.keywords).toBe("minimal, editorial, serif");
    expect(result.dateModified).toBe("2026-03-25T14:00:00Z");
    expect(result.image).toBe("https://example.com/shot-1.png");
    expect(result.license).toBe("MIT");
  });

  it("falls back to /og/theme/{id}.png when screenshotUrls is empty", () => {
    const theme = makeTheme({ screenshotUrls: [], screenshotCount: 0 });
    const result = buildThemeJsonLd(theme, NO_REVIEWS);
    expect(result.image).toBe(
      "https://emdashcms.org/og/theme/minimalist.png",
    );
  });

  it("includes aggregateRating when reviewStats.totalCount > 0", () => {
    const theme = makeTheme();
    const result = buildThemeJsonLd(theme, {
      averageRating: 4.2,
      totalCount: 5,
    });
    expect(result.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.2,
      reviewCount: 5,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("omits aggregateRating when no reviews", () => {
    const theme = makeTheme();
    const result = buildThemeJsonLd(theme, NO_REVIEWS);
    expect("aggregateRating" in result).toBe(false);
  });

  it("omits license when theme.license is null", () => {
    const theme = makeTheme({ license: null });
    const result = buildThemeJsonLd(theme, NO_REVIEWS);
    expect("license" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildOrganizationJsonLd
// ---------------------------------------------------------------------------

describe("buildOrganizationJsonLd", () => {
  it("returns the Organization payload with the marketplace repo in sameAs", () => {
    const result = buildOrganizationJsonLd();
    expect(result).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "EmDash CMS Marketplace",
      url: "https://emdashcms.org",
      logo: "https://emdashcms.org/favicon.svg",
      sameAs: ["https://github.com/chrisjohnleah/emdashcms-org"],
    });
  });
});
