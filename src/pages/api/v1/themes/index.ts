import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { searchThemes } from "../../../../lib/db/queries";
import { parsePaginationParams } from "../../../../lib/api/pagination";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const keyword = url.searchParams.get("keyword") ?? null;
  const sort = url.searchParams.get("sort") ?? "created";
  const { cursor, limit } = parsePaginationParams(url);

  try {
    const results = await searchThemes(env.DB, {
      query,
      keyword,
      sort,
      cursor,
      limit,
    });
    return jsonResponse(results);
  } catch (err) {
    console.error("[api] Theme search error:", err);
    return errorResponse(500, "Internal server error");
  }
};
