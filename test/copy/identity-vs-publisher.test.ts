/**
 * Phase 23-03 grep gate.
 *
 * Two responsibilities:
 *
 *  1. Walker assertion — fail CI if any single template under
 *     `src/components/**\/*.astro` or `src/pages/**\/*.astro` mixes the
 *     literal substrings "author profile" and "member profile" (case
 *     insensitive). Mixing within one file means a surface was split
 *     across both vocabularies, which contradicts the allow-list
 *     classification at
 *     `.planning/phases/23-member-identity-model-cleanup/23-03-COPY-ALLOWLIST.md`.
 *
 *  2. Three explicit spot-checks anchoring the allow-list outcome for
 *     known KEEP surfaces. The 23-03 allow-list documents that the
 *     codebase ships ZERO Author→Member REPLACE rows because the
 *     identity surfaces the plan assumed exist (Footer auth links,
 *     "Author settings" heading, "Author is banned" notice rendered to
 *     the banned user) do not exist in shipped templates — every
 *     user-visible Author/author occurrence is on a publisher surface
 *     (publisher attribution, /authors/[username] public profile, admin
 *     "Authors" tables, embed snippets, docs). The spot-checks below
 *     pin that reality so any future refactor that DOES introduce a
 *     stray "Member" string on a publisher surface (or removes "Author"
 *     from the public author profile route) trips this test.
 *
 * Implementation notes:
 *  - Uses Vite's `import.meta.glob({ query: "?raw", import: "default", eager: true })`
 *    so file contents are inlined at bundle time. This sidesteps the
 *    vitest-pool-workers sandbox path issue (the workers runtime mounts
 *    the bundle at `/bundle/` and `readFileSync("src/...")` resolves to
 *    `/bundle/src/...` which does not contain the host filesystem).
 *    The same `?raw` pattern is already in use across the test suite
 *    (e.g. `test/api/detail-pages-seo.test.ts` line 29 imports
 *    `BaseLayout.astro?raw`).
 *  - The walker normalises content to lowercase so "Author Profile",
 *    "AUTHOR PROFILE", and "author profile" all collapse to the same
 *    needle, matching the grep semantics intended by the plan.
 */

import { describe, it, expect } from "vitest";

// Spot-check fixtures imported as raw strings at bundle time.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Vite raw imports are typed via vite/client globally.
import embedBadgesSrc from "../../src/components/EmbedBadgesPanel.astro?raw";
// @ts-ignore
import authorsUsernameSrc from "../../src/pages/authors/[username].astro?raw";
// @ts-ignore
import indexSrc from "../../src/pages/index.astro?raw";

// Vite glob returns a record keyed by absolute-from-project paths
// (e.g. "/src/components/Footer.astro") to file contents. Eager mode
// inlines everything at bundle time; the workers runtime never touches
// disk.
const componentSources = import.meta.glob<string>(
  "/src/components/**/*.astro",
  { query: "?raw", import: "default", eager: true },
);
const pageSources = import.meta.glob<string>("/src/pages/**/*.astro", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("UI copy — identity vs publisher classification gate", () => {
  it('no template file mixes "author profile" and "member profile"', () => {
    const offenders: string[] = [];
    for (const [path, content] of Object.entries({
      ...componentSources,
      ...pageSources,
    })) {
      const lower = content.toLowerCase();
      if (
        lower.includes("author profile") &&
        lower.includes("member profile")
      ) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("EmbedBadgesPanel.astro keeps publisher vocabulary (no Member identity strings)", () => {
    // Embed snippets are publisher-flow surface — KEEP per 23-03
    // allow-list. A future commit that adds a "Member" identity string
    // to this file is almost certainly a misclassification.
    expect((embedBadgesSrc as string).includes("Member")).toBe(false);
  });

  it("/authors/[username].astro keeps Author (public publisher profile route)", () => {
    // The /authors/[username] public profile route is the canonical
    // publisher attribution surface and is explicitly KEEP per
    // 23-03-PLAN.md interfaces block. The route URL itself is also
    // publisher-side per STATE.md deferred items.
    expect((authorsUsernameSrc as string).includes("Author")).toBe(true);
  });

  it("/index.astro ban-from-publishing notice uses identity-neutral language (no 'Author' label rendered to the banned user)", () => {
    // The OAuth-ban-redirect notice on the homepage renders TO the
    // affected user. Per 23-03-PLAN.md interfaces, ban messages
    // surfaced to the banned user are identity-side surface.
    // The shipped notice already uses the identity-neutral "Your
    // account has been suspended from publishing." phrasing — pin it
    // so a future refactor that introduces "Author" into this notice
    // (e.g. "Your Author account has been suspended") fails CI.
    const content = indexSrc as string;
    // Locate the banned-notice block and assert it does not
    // user-visibly say "Author" near the banned phrasing.
    const bannedSectionMatch = content.match(
      /showBannedNotice[\s\S]{0,1200}?<\/div>\s*<\/div>\s*\)\}/,
    );
    expect(bannedSectionMatch).not.toBeNull();
    const bannedSection = bannedSectionMatch?.[0] ?? "";
    expect(bannedSection.toLowerCase()).toContain("account has been suspended");
    // "Author" is allowed to appear elsewhere on the homepage (publisher
    // attribution on featured plugins) but not inside the ban notice.
    expect(bannedSection).not.toMatch(/\bAuthor\b/);
  });
});
