export interface PaginationCursor {
  s: string | number; // sort column value
  id: string; // primary key (tiebreaker)
}

export function encodeCursor(sortValue: string | number, id: string): string {
  return btoa(JSON.stringify({ s: sortValue, id }));
}

export function decodeCursor(cursor: string): PaginationCursor | null {
  try {
    const parsed = JSON.parse(atob(cursor));
    if (parsed && typeof parsed.id === "string" && "s" in parsed) {
      return parsed as PaginationCursor;
    }
    return null;
  } catch {
    return null;
  }
}

export function parsePaginationParams(url: URL): {
  cursor: string | null;
  limit: number;
} {
  const cursor = url.searchParams.get("cursor");
  const rawLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);
  return { cursor, limit };
}
