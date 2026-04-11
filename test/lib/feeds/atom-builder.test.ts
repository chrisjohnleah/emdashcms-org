import { describe, it } from "vitest";
// Coverage for 14-CONTEXT.md D-03 (escape) + D-04 (50 cap) + D-05 (tag: URI)
// + D-07 (author element) + D-15/D-16 (summary/content) + T-14-01 (XML injection).
describe("escapeXml", () => {
  it.todo('replaces & first, then < > " \' in that order (order matters)');
  it.todo('handles "a & <b>" -> "a &amp; &lt;b&gt;"');
  it.todo('handles the adversarial payload <script>alert("x")</script>');
  it.todo(
    "does NOT double-escape existing &amp; entities (still becomes &amp;amp;) — document the one-pass behaviour",
  );
  it.todo("escapes numeric entities and CDATA-boundary payloads safely");
});
describe("buildFeed", () => {
  it.todo('emits <?xml version="1.0" encoding="utf-8"?> header');
  it.todo('emits <feed xmlns="http://www.w3.org/2005/Atom">');
  it.todo(
    'emits <link rel="self" type="application/atom+xml" href="..."/> with absolute URL',
  );
  it.todo("emits a feed-level <author> element (emdashcms.org)");
  it.todo("emits feed-level <updated> = MAX(entry.updated) when entries present");
  it.todo("emits feed-level <updated> = now when entries array is empty");
  it.todo("renders zero-entry feed without throwing");
  it.todo("hard-caps entry output at 50 even when input contains 60 entries");
  it.todo('emits <summary type="text"> with escaped plain text');
  it.todo(
    'emits <content type="html"><![CDATA[...]]></content> when contentHtml provided',
  );
  it.todo("OMITS <content> entirely when contentHtml is null");
  it.todo("splits ]]> sequences inside contentHtml into ]]]]><![CDATA[>");
  it.todo(
    "emits <author><name>...</name><uri>https://github.com/...</uri></author>",
  );
  it.todo("NEVER emits <email> in <author>");
  it.todo('emits <category term="..."/> when categoryTerm is provided');
  it.todo("omits <category> when categoryTerm is null/undefined");
  it.todo("entry <id> values are the tag: URIs provided by the caller (unchanged)");
});
