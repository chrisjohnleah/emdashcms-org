import { describe, expect, it } from "vitest";
import {
  listRegistryPackages,
  normalisePackage,
  normaliseRelease,
  safeUrl,
} from "../../../src/lib/registry/client";
import { describeAccess } from "../../../src/lib/registry/access";

const PKG = {
  did: "did:plc:abc",
  handle: "swiss.ky",
  slug: "linguadash",
  latestVersion: "0.1.0",
  profile: {
    name: "LinguaDash",
    description: "Translate content.",
    license: "MIT",
    keywords: ["i18n", 3],
    authors: [{ name: "swissky", url: "javascript:alert(1)" }],
    sections: { description: "**Hi**", installation: "" },
    extensions: {
      "com.emdashcms.experimental.package.profileExtension": { repository: "https://github.com/x/y" },
    },
  },
};

describe("registry client", () => {
  it("normalises a package and strips unsafe URLs", () => {
    const p = normalisePackage(PKG)!;
    expect(p.publicName).toBe("@swiss.ky/linguadash");
    expect(p.officialUrl).toBe("https://plugins.emdashcms.com/plugins/@swiss.ky/linguadash");
    expect(p.keywords).toEqual(["i18n"]);
    expect(p.authors).toEqual([{ name: "swissky", url: null }]);
    expect(p.repository).toBe("https://github.com/x/y");
    expect(p.sections).toEqual({ description: "**Hi**" });
  });

  it("falls back to a title-cased slug and drops fixtures and junk", () => {
    expect(normalisePackage({ ...PKG, slug: "ai-search", profile: {} })!.name).toBe("Ai Search");
    expect(normalisePackage({ ...PKG, slug: "marketplace-test" })).toBeNull();
    expect(normalisePackage({ ...PKG, handle: "../evil" })).toBeNull();
    expect(normalisePackage(null)).toBeNull();
  });

  it("flattens declaredAccess into readable permissions", () => {
    const r = normaliseRelease({
      version: "0.1.0",
      release: {
        requires: { "env:emdash": ">=0.42.0" },
        extensions: {
          "com.emdashcms.experimental.package.releaseExtension": {
            declaredAccess: {
              content: { read: {}, revisionsRead: {} },
              network: { request: { allowedHosts: ["api.deepl.com"] } },
            },
          },
        },
      },
    })!;
    expect(r.requires).toBe(">=0.42.0");
    expect(describeAccess(r.access)).toEqual([
      { label: "Site content", detail: "Can read, revisions read" },
      { label: "Outbound network requests", detail: "Can contact: api.deepl.com" },
    ]);
  });

  it("pages through searchPackages and degrades to [] on failure", async () => {
    const pages = [
      { packages: [PKG], cursor: "next" },
      { packages: [{ ...PKG, slug: "eventual" }] },
    ];
    const seen: string[] = [];
    const ok = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(pages[seen.length - 1]));
    }) as unknown as typeof fetch;
    expect((await listRegistryPackages(ok)).map((p) => p.slug)).toEqual(["linguadash", "eventual"]);
    expect(seen[1]).toContain("cursor=next");

    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await listRegistryPackages(down)).toEqual([]);
  });

  it("only allows http(s) URLs", () => {
    expect(safeUrl("https://a.b/")).toBe("https://a.b/");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});
