// Phase 14: Site-wide feed set per D-34. BaseLayout imports SITE_WIDE_FEEDS as
// the default when a page does not pass its own `feeds` prop. See 14-CONTEXT.md
// D-34/D-35.

export interface FeedLink {
  title: string;
  /** Absolute URL — feed autodiscovery clients expect absolute. */
  href: string;
}

export const SITE_WIDE_FEEDS: readonly FeedLink[] = [
  {
    title: "emdashcms.org — new plugins",
    href: "https://emdashcms.org/feeds/plugins/new.xml",
  },
];

/**
 * Resolves the effective feed set for a page.
 *
 * - Dashboard pages (path startsWith '/dashboard') emit nothing per D-34.
 * - A consumer can pass an empty array to silence tags on a specific page.
 * - A consumer can pass a custom list to override the site-wide default.
 * - Undefined override falls back to SITE_WIDE_FEEDS.
 *
 * Task 4 fills in the body (Wave 0 ships a stub so downstream imports compile).
 */
export function resolveEffectiveFeeds(
  _currentPath: string,
  _override?: readonly FeedLink[],
): readonly FeedLink[] {
  throw new Error("not implemented (Task 4)");
}
