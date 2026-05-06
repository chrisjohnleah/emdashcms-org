import { describe, expect, it } from "vitest";

import aboutSource from "../../src/pages/about.astro?raw";
import homepageSource from "../../src/pages/index.astro?raw";
import llmsSource from "../../src/lib/seo/llms-txt.ts?raw";
import roadmapSource from "../../src/pages/roadmap.astro?raw";
import sitemapSource from "../../src/lib/seo/sitemap.ts?raw";

describe("public project positioning surfaces", () => {
  it("keeps the about page explicit about the core CMS and marketplace split", () => {
    expect(aboutSource).toContain("The core CMS lives at emdashcms.com");
    expect(aboutSource).toContain("This site is the ecosystem home");
    expect(aboutSource).toContain("public marketplace and project hub around EmDash");
  });

  it("keeps support and security expectations visible on the about page", () => {
    expect(aboutSource).toContain("There is no central support forum yet");
    expect(aboutSource).toContain("Report a listing");
    expect(aboutSource).toContain("Security policy");
    expect(aboutSource).toContain("MIT-licensed");
  });

  it("links the about page from human and machine discovery surfaces", () => {
    expect(homepageSource).toContain('href="/about"');
    expect(sitemapSource).toContain("`${SITE_URL}/about`");
    expect(llmsSource).toContain("[About emdashcms.org](https://emdashcms.org/about)");
  });

  it("keeps the roadmap honest about dates, security, and adoption claims", () => {
    expect(roadmapSource).toContain("This is not a promise of dates");
    expect(roadmapSource).toContain("Security can interrupt the plan");
    expect(roadmapSource).toContain("No fake showcase");
    expect(roadmapSource).toContain("should not invent adoption");
  });

  it("links the roadmap from human and machine discovery surfaces", () => {
    expect(aboutSource).toContain("href: '/roadmap'");
    expect(homepageSource).toContain('href="/roadmap"');
    expect(sitemapSource).toContain("`${SITE_URL}/roadmap`");
    expect(llmsSource).toContain("[Roadmap](https://emdashcms.org/roadmap)");
  });
});
