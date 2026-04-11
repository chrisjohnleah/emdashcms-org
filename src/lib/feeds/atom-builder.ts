// Phase 14: Hand-rolled Atom 1.0 builder per 14-CONTEXT.md D-01/D-02/D-03.
// Implemented in Task 3. RFC 4287 compliant. Zero dependencies.
export interface FeedEntry {
  id: string;
  title: string;
  updated: string;
  alternateUrl: string;
  summary: string;
  contentHtml: string | null;
  author: { name: string; uri: string };
  categoryTerm?: string | null;
}
export interface Feed {
  id: string;
  title: string;
  selfUrl: string;
  alternateUrl: string;
  entries: FeedEntry[];
}
export function escapeXml(_s: string): string {
  throw new Error("not implemented (Task 3)");
}
export function buildFeed(_feed: Feed): string {
  throw new Error("not implemented (Task 3)");
}
