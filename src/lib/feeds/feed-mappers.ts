// Phase 14: Row -> FeedEntry mappers.
//
// These map the focused query-shape rows from `feed-queries.ts` to the
// `FeedEntry` shape the atom-builder consumes. The mappers are where
// the RFC 4151 tag: URI scheme gets baked in (D-05) with the locked
// `2026` year component, and where the optional markdown content body
// is rendered via the existing `renderPluginMarkdown` helper per D-16.
//
// Author element shape is locked by D-07: `name` + `uri` only; NO
// email element is ever emitted — see the atom-builder for the XML.

import type { FeedEntry } from "./atom-builder";
import type {
  FeedPluginRow,
  FeedPluginVersionRow,
  FeedThemeRow,
} from "./feed-queries";
import { renderPluginMarkdown } from "../markdown";

const SITE = "https://emdashcms.org";
/** LOCKED per D-05 — do not dynamically compute. The year component of a
 * tag: URI must be stable for the lifetime of the feed entry so that
 * aggregators can dedupe entries across reloads. */
const TAG_YEAR = "2026";

function tagPlugin(id: string): string {
  return `tag:emdashcms.org,${TAG_YEAR}:plugin:${id}`;
}

function tagPluginVersion(pluginId: string, version: string): string {
  return `tag:emdashcms.org,${TAG_YEAR}:plugin:${pluginId}:v${version}`;
}

function tagTheme(id: string): string {
  return `tag:emdashcms.org,${TAG_YEAR}:theme:${id}`;
}

function authorFrom(login: string): { name: string; uri: string } {
  return { name: login, uri: `https://github.com/${login}` };
}

/**
 * Render markdown description → HTML for the `<content type="html">`
 * element. Returns null on empty input so the atom-builder can omit
 * the element entirely (D-16).
 */
function contentFrom(description: string | null): string | null {
  return renderPluginMarkdown(description);
}

export interface PluginFeedContext {
  kind: "new";
  /** Informational only — present on the category route. */
  category?: string;
}

export function pluginsToFeedEntries(
  rows: FeedPluginRow[],
  _ctx: PluginFeedContext,
): FeedEntry[] {
  return rows.map(
    (r): FeedEntry => ({
      id: tagPlugin(r.id),
      title: r.name,
      updated: r.createdAt,
      alternateUrl: `${SITE}/plugins/${r.id}`,
      summary: r.shortDescription ?? "",
      contentHtml: contentFrom(r.description),
      author: authorFrom(r.authorLogin),
      categoryTerm: r.category,
    }),
  );
}

export function pluginVersionsToFeedEntries(
  rows: FeedPluginVersionRow[],
): FeedEntry[] {
  return rows.map(
    (r): FeedEntry => ({
      id: tagPluginVersion(r.pluginId, r.version),
      title: `${r.name} v${r.version}`,
      updated: r.publishedAt,
      alternateUrl: `${SITE}/plugins/${r.pluginId}`,
      summary: r.shortDescription ?? "",
      contentHtml: contentFrom(r.description),
      author: authorFrom(r.authorLogin),
      categoryTerm: r.category,
    }),
  );
}

export function themesToFeedEntries(rows: FeedThemeRow[]): FeedEntry[] {
  return rows.map(
    (r): FeedEntry => ({
      id: tagTheme(r.id),
      title: r.name,
      updated: r.createdAt,
      alternateUrl: `${SITE}/themes/${r.id}`,
      summary: r.shortDescription ?? "",
      contentHtml: contentFrom(r.description),
      author: authorFrom(r.authorLogin),
      categoryTerm: null,
    }),
  );
}
