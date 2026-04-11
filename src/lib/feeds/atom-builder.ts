// Phase 14: Hand-rolled Atom 1.0 builder per 14-CONTEXT.md D-01/D-02/D-03.
// RFC 4287 compliant. Zero dependencies. Every user-controlled string
// flows through `escapeXml()` once, with `&` replaced first so literal
// ampersands in the source can never double-entity.
//
// See 14-RESEARCH.md §2 for the element checklist and §2.5 for the
// CDATA `]]>` splitter rationale.

export interface FeedEntry {
  /** Full tag: URI per RFC 4151. */
  id: string;
  title: string;
  /** ISO8601 UTC with 'Z' suffix. */
  updated: string;
  /** Absolute URL to the canonical detail page. */
  alternateUrl: string;
  /** Plain text — escaped inside buildFeed. */
  summary: string;
  /** Markdown-rendered HTML. null = omit <content> entirely. */
  contentHtml: string | null;
  /** GitHub display name + profile URL. No contact address per D-07. */
  author: { name: string; uri: string };
  /** Optional category term; null/undefined to omit. */
  categoryTerm?: string | null;
}

export interface Feed {
  /** Feed-level tag: URI. */
  id: string;
  title: string;
  /** Absolute self-link URL. */
  selfUrl: string;
  /** Absolute alternate (HTML) URL. */
  alternateUrl: string;
  entries: FeedEntry[];
}

/** Site-wide feed author element per D-07 (name + uri only, no contact). */
const SITE_AUTHOR = { name: "emdashcms.org", uri: "https://emdashcms.org" };

/** Hard entry cap per D-04. */
const MAX_ENTRIES = 50;

/**
 * Escape the five XML special characters. `&` MUST run first — any other
 * order would double-escape a literal `&` occurring later in the input.
 * See 14-RESEARCH.md §2.4 and R-03.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Split any literal `]]>` sequence inside an HTML payload across two
 * CDATA sections. Without this splitter, an adversarial or incidental
 * `]]>` would terminate the surrounding CDATA block and break the XML.
 */
function splitCdata(html: string): string {
  return html.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

/**
 * Render a feed to an Atom 1.0 XML string. Always emits a well-formed
 * document: xmlns, feed id/title/updated, self + alternate links, a
 * site-level author, and up to MAX_ENTRIES entries with their own
 * author, summary, optional content, and optional category.
 */
export function buildFeed(feed: Feed): string {
  const entries = feed.entries.slice(0, MAX_ENTRIES);

  const feedUpdated =
    entries.length > 0
      ? entries.reduce(
          (max, e) => (e.updated > max ? e.updated : max),
          entries[0].updated,
        )
      : new Date().toISOString();

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="utf-8"?>');
  parts.push('<feed xmlns="http://www.w3.org/2005/Atom">');
  parts.push(`  <id>${escapeXml(feed.id)}</id>`);
  parts.push(`  <title>${escapeXml(feed.title)}</title>`);
  parts.push(`  <updated>${escapeXml(feedUpdated)}</updated>`);
  parts.push(
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feed.selfUrl)}"/>`,
  );
  parts.push(
    `  <link rel="alternate" type="text/html" href="${escapeXml(feed.alternateUrl)}"/>`,
  );
  parts.push(
    `  <author><name>${escapeXml(SITE_AUTHOR.name)}</name><uri>${escapeXml(SITE_AUTHOR.uri)}</uri></author>`,
  );

  for (const e of entries) {
    parts.push("  <entry>");
    parts.push(`    <id>${escapeXml(e.id)}</id>`);
    parts.push(`    <title>${escapeXml(e.title)}</title>`);
    parts.push(`    <updated>${escapeXml(e.updated)}</updated>`);
    parts.push(
      `    <link rel="alternate" type="text/html" href="${escapeXml(e.alternateUrl)}"/>`,
    );
    parts.push(
      `    <author><name>${escapeXml(e.author.name)}</name><uri>${escapeXml(e.author.uri)}</uri></author>`,
    );
    if (e.categoryTerm) {
      parts.push(`    <category term="${escapeXml(e.categoryTerm)}"/>`);
    }
    parts.push(`    <summary type="text">${escapeXml(e.summary)}</summary>`);
    if (e.contentHtml !== null && e.contentHtml !== "") {
      parts.push(
        `    <content type="html"><![CDATA[${splitCdata(e.contentHtml)}]]></content>`,
      );
    }
    parts.push("  </entry>");
  }

  parts.push("</feed>");
  return parts.join("\n");
}
