import { describe, it, expect } from "vitest";
import {
  buildFeed,
  escapeXml,
  type FeedEntry,
} from "../../../src/lib/feeds/atom-builder";

// Coverage for 14-CONTEXT.md D-03 (escape) + D-04 (50 cap) + D-05 (tag: URI)
// + D-07 (author element) + D-15/D-16 (summary/content) + T-14-01 (XML injection).

function entry(partial: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: "tag:emdashcms.org,2026:plugin:example",
    title: "Example Plugin",
    updated: "2026-04-08T12:00:00Z",
    alternateUrl: "https://emdashcms.org/plugins/example",
    summary: "An example plugin",
    contentHtml: null,
    author: { name: "alice-dev", uri: "https://github.com/alice-dev" },
    categoryTerm: null,
    ...partial,
  };
}

describe("escapeXml", () => {
  it('replaces & first, then < > " \' in that order (order matters)', () => {
    expect(escapeXml("a & <b> \"c\" 'd'")).toBe(
      "a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;",
    );
  });

  it('handles "a & <b>" -> "a &amp; &lt;b&gt;"', () => {
    expect(escapeXml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it('handles the adversarial payload <script>alert("x")</script>', () => {
    const out = escapeXml('<script>alert("x")</script>');
    expect(out).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    // No unescaped angle brackets surviving.
    expect(out).not.toMatch(/<script/);
  });

  it("does NOT double-escape existing &amp; entities (still becomes &amp;amp;) — document the one-pass behaviour", () => {
    // `&amp;` in source is treated as a literal `&amp;` — the `&` is
    // escaped to `&amp;`, producing `&amp;amp;`. This is the documented
    // one-pass behaviour. Callers should not pre-escape.
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("escapes numeric entities and CDATA-boundary payloads safely", () => {
    // A raw `&#x41;` becomes `&amp;#x41;` — not interpreted as an entity.
    expect(escapeXml("&#x41;")).toBe("&amp;#x41;");
    // A raw `]]>` is escaped structurally — the builder also handles CDATA.
    expect(escapeXml("foo ]]> bar")).toBe("foo ]]&gt; bar");
  });
});

describe("buildFeed", () => {
  const baseFeed = {
    id: "tag:emdashcms.org,2026:feed:plugins:new",
    title: "emdashcms.org — new plugins",
    selfUrl: "https://emdashcms.org/feeds/plugins/new.xml",
    alternateUrl: "https://emdashcms.org/plugins",
  };

  it('emits <?xml version="1.0" encoding="utf-8"?> header', () => {
    const xml = buildFeed({ ...baseFeed, entries: [] });
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
  });

  it('emits <feed xmlns="http://www.w3.org/2005/Atom">', () => {
    const xml = buildFeed({ ...baseFeed, entries: [] });
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  });

  it('emits <link rel="self" type="application/atom+xml" href="..."/> with absolute URL', () => {
    const xml = buildFeed({ ...baseFeed, entries: [] });
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://emdashcms.org/feeds/plugins/new.xml"/>',
    );
  });

  it("emits a feed-level <author> element (emdashcms.org)", () => {
    const xml = buildFeed({ ...baseFeed, entries: [] });
    expect(xml).toContain(
      "<author><name>emdashcms.org</name><uri>https://emdashcms.org</uri></author>",
    );
  });

  it("emits feed-level <updated> = MAX(entry.updated) when entries present", () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [
        entry({ id: "tag:emdashcms.org,2026:plugin:a", updated: "2026-01-01T00:00:00Z" }),
        entry({ id: "tag:emdashcms.org,2026:plugin:b", updated: "2026-06-01T00:00:00Z" }),
        entry({ id: "tag:emdashcms.org,2026:plugin:c", updated: "2026-03-01T00:00:00Z" }),
      ],
    });
    // The feed-level <updated> must be the MAX.
    const feedUpdatedMatch = xml.match(
      /<feed[^>]*>[\s\S]*?<updated>([^<]+)<\/updated>/,
    );
    expect(feedUpdatedMatch?.[1]).toBe("2026-06-01T00:00:00Z");
  });

  it("emits feed-level <updated> = now when entries array is empty", () => {
    const before = new Date().toISOString();
    const xml = buildFeed({ ...baseFeed, entries: [] });
    const after = new Date().toISOString();
    const feedUpdatedMatch = xml.match(
      /<feed[^>]*>[\s\S]*?<updated>([^<]+)<\/updated>/,
    );
    expect(feedUpdatedMatch?.[1]).toBeDefined();
    // Within the test window (ISO lexicographic comparison works here).
    expect(feedUpdatedMatch![1] >= before).toBe(true);
    expect(feedUpdatedMatch![1] <= after).toBe(true);
  });

  it("renders zero-entry feed without throwing", () => {
    expect(() => buildFeed({ ...baseFeed, entries: [] })).not.toThrow();
  });

  it("hard-caps entry output at 50 even when input contains 60 entries", () => {
    const sixty = Array.from({ length: 60 }, (_, i) =>
      entry({
        id: `tag:emdashcms.org,2026:plugin:p${i}`,
        title: `Plugin ${i}`,
      }),
    );
    const xml = buildFeed({ ...baseFeed, entries: sixty });
    const count = (xml.match(/<entry>/g) ?? []).length;
    expect(count).toBe(50);
  });

  it('emits <summary type="text"> with escaped plain text', () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [entry({ summary: "plugin & co <3" })],
    });
    expect(xml).toContain(
      '<summary type="text">plugin &amp; co &lt;3</summary>',
    );
  });

  it('emits <content type="html"><![CDATA[...]]></content> when contentHtml provided', () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [entry({ contentHtml: "<p>Hello <strong>world</strong></p>" })],
    });
    expect(xml).toContain(
      '<content type="html"><![CDATA[<p>Hello <strong>world</strong></p>]]></content>',
    );
  });

  it("OMITS <content> entirely when contentHtml is null", () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [entry({ contentHtml: null })],
    });
    expect(xml).not.toContain("<content");
  });

  it("splits ]]> sequences inside contentHtml into ]]]]><![CDATA[>", () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [entry({ contentHtml: "foo ]]> bar" })],
    });
    expect(xml).toContain(
      "<content type=\"html\"><![CDATA[foo ]]]]><![CDATA[> bar]]></content>",
    );
  });

  it("emits <author><name>...</name><uri>https://github.com/...</uri></author>", () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [
        entry({
          author: { name: "bob-plugins", uri: "https://github.com/bob-plugins" },
        }),
      ],
    });
    expect(xml).toContain(
      "<author><name>bob-plugins</name><uri>https://github.com/bob-plugins</uri></author>",
    );
  });

  it("NEVER emits <email> in <author>", () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [
        entry({
          author: {
            name: "alice-dev",
            uri: "https://github.com/alice-dev",
          },
        }),
      ],
    });
    expect(xml).not.toContain("<email>");
    expect(xml).not.toContain("email");
  });

  it('emits <category term="..."/> when categoryTerm is provided', () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [entry({ categoryTerm: "content" })],
    });
    expect(xml).toContain('<category term="content"/>');
  });

  it("omits <category> when categoryTerm is null/undefined", () => {
    const xmlNull = buildFeed({
      ...baseFeed,
      entries: [entry({ categoryTerm: null })],
    });
    expect(xmlNull).not.toContain("<category");
    const xmlUndef = buildFeed({
      ...baseFeed,
      entries: [entry({ categoryTerm: undefined })],
    });
    expect(xmlUndef).not.toContain("<category");
  });

  it("entry <id> values are the tag: URIs provided by the caller (unchanged)", () => {
    const xml = buildFeed({
      ...baseFeed,
      entries: [
        entry({ id: "tag:emdashcms.org,2026:plugin:seo-toolkit:v1.2.3" }),
      ],
    });
    expect(xml).toContain(
      "<id>tag:emdashcms.org,2026:plugin:seo-toolkit:v1.2.3</id>",
    );
  });

  it("feed id is the locked feed-level tag: URI", () => {
    const xml = buildFeed({ ...baseFeed, entries: [] });
    expect(xml).toContain("<id>tag:emdashcms.org,2026:feed:plugins:new</id>");
  });
});
