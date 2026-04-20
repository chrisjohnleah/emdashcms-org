import type {
  MarketplacePluginDetail,
  MarketplaceThemeDetail,
} from "../../types/marketplace";
import type { ReviewStats } from "../db/review-queries";

/**
 * Schema.org JSON-LD builders for AI and social discoverability.
 *
 * These are pure functions: they take typed input, return plain
 * `Record<string, unknown>` objects, and do NOT stringify, escape,
 * or wrap the result in any way. Emission (JSON.stringify + the
 * `</script>` injection-defense escape) lives in BaseLayout — see
 * the `jsonLdArray.map` block — so these builders stay trivially
 * unit-testable without touching Astro or HTML.
 *
 * Fields follow Schema.org's SoftwareApplication / CreativeWork /
 * Organization vocabularies. Optional fields are omitted rather
 * than emitted as `null` so the resulting JSON matches what Google
 * Rich Results Test expects.
 */

const SITE_URL = "https://emdashcms.org";

/**
 * Build a SoftwareApplication JSON-LD payload for a plugin detail
 * page. `latestVersion` carries the raw snake_case field names from
 * the plugin_versions row so the caller can coalesce
 * `published_at ?? created_at` at the boundary; pass `null` when
 * the plugin has no published version (the builder will omit the
 * version-dependent fields).
 */
export function buildPluginJsonLd(
  plugin: MarketplacePluginDetail,
  latestVersion: {
    version: string;
    published_at: string | null;
    created_at: string;
  } | null,
  reviewStats: ReviewStats,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: plugin.name,
    description: plugin.shortDescription ?? plugin.description ?? plugin.name,
    url: `${SITE_URL}/plugins/${plugin.id}`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "EmDash CMS",
    author: {
      "@type": "Person",
      name: plugin.author.name,
      url: `https://github.com/${plugin.author.name}`,
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    dateModified: plugin.updatedAt,
  };

  if (latestVersion) {
    result.softwareVersion = latestVersion.version;
    result.downloadUrl = `${SITE_URL}/api/v1/plugins/${plugin.id}/versions/${latestVersion.version}/bundle`;
    // Nullable published_at is a documented lesson from the D1 layer:
    // we coalesce to created_at so datePublished is always a real date.
    result.datePublished =
      latestVersion.published_at ?? latestVersion.created_at;
  }

  if (plugin.keywords.length > 0) {
    result.keywords = plugin.keywords.join(", ");
  }

  if (reviewStats.totalCount > 0) {
    result.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: reviewStats.averageRating,
      reviewCount: reviewStats.totalCount,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return result;
}

/**
 * Build a CreativeWork JSON-LD payload for a theme detail page.
 * Themes are metadata-only in the marketplace (no bundle in R2), so
 * the downloadable-artifact fields from SoftwareApplication do not
 * apply — CreativeWork is the correct parent type.
 */
export function buildThemeJsonLd(
  theme: MarketplaceThemeDetail,
  reviewStats: ReviewStats,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: theme.name,
    description: theme.shortDescription ?? theme.description ?? theme.name,
    url: `${SITE_URL}/themes/${theme.id}`,
    author: {
      "@type": "Person",
      name: theme.author.name,
      url: `https://github.com/${theme.author.name}`,
    },
    dateModified: theme.updatedAt,
    // First screenshot when present, otherwise fall through to the
    // generated OG image so every theme has a real `image` for social
    // cards — Plan 02 wires /og/theme/{id}.png to a workers-og route.
    image:
      theme.screenshotUrls && theme.screenshotUrls.length > 0
        ? theme.screenshotUrls[0]
        : `${SITE_URL}/og/theme/${theme.id}.png`,
  };

  if (theme.keywords.length > 0) {
    result.keywords = theme.keywords.join(", ");
  }

  if (theme.license) {
    result.license = theme.license;
  }

  if (reviewStats.totalCount > 0) {
    result.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: reviewStats.averageRating,
      reviewCount: reviewStats.totalCount,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return result;
}

/**
 * Build the site-root Organization JSON-LD payload. Emitted only on
 * the homepage; other pages inherit the BreadcrumbList / per-entity
 * schemas they need instead. `sameAs` points at the marketplace repo
 * — NOT the upstream EmDash CMS repo — because this is the identity
 * the marketplace asserts on its own homepage.
 */
export function buildOrganizationJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "EmDash CMS Marketplace",
    url: SITE_URL,
    logo: `${SITE_URL}/favicon.svg`,
    sameAs: ["https://github.com/chrisjohnleah/emdashcms-org"],
  };
}

export interface Breadcrumb {
  /** Visible label (e.g. "Plugins", "Content", "SEO Toolkit"). */
  name: string;
  /**
   * Absolute or site-relative URL for the crumb. Relative paths are
   * resolved against SITE_URL so callers can pass `/plugins` directly.
   * Pass `undefined` for the current page — Schema.org allows the last
   * crumb's `item` to be omitted, but Google's reference implementation
   * prefers a value on every entry, so we always emit one.
   */
  url: string;
}

/**
 * Build a BreadcrumbList JSON-LD payload for hierarchical navigation
 * surfaces (plugin/theme detail pages, category listings). Google SGE
 * and AI search engines use this to render breadcrumb trails in
 * citations and to understand site structure without a full crawl.
 *
 * Position is 1-indexed per Schema.org. Callers should include the
 * top-level section ("Plugins") as crumb 1, intermediate parents in
 * order, and the current page as the final crumb.
 */
export function buildBreadcrumbListJsonLd(
  crumbs: Breadcrumb[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.url.startsWith("http")
        ? crumb.url
        : `${SITE_URL}${crumb.url}`,
    })),
  };
}

export interface FaqItem {
  /** The question exactly as the user would ask it. */
  question: string;
  /** Plain-text answer. HTML is NOT escaped here — emission handles it. */
  answer: string;
}

/**
 * Build a FAQPage JSON-LD payload. Google, ChatGPT, and Perplexity
 * cite FAQ content disproportionately often — the Princeton GEO study
 * measured roughly a 40% visibility uplift when a page emits FAQPage
 * alongside its primary content schema. Keep questions phrased the way
 * a real user would ask them (not marketing-voice headlines).
 */
export function buildFaqPageJsonLd(
  faqs: FaqItem[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}
