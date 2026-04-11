// Phase 14: ISO 8601 week math per 14-CONTEXT.md D-23. Implemented in Task 2.
export interface IsoWeek {
  year: number;
  week: number;
  slug: string;
  startUtc: string;
  endUtc: string;
}
export function getIsoWeek(_input: Date): IsoWeek {
  throw new Error("not implemented (Task 2)");
}
export function parseIsoWeekSlug(_slug: string): IsoWeek | null {
  throw new Error("not implemented (Task 2)");
}
export function formatHumanRange(_week: IsoWeek): string {
  throw new Error("not implemented (Task 2)");
}
