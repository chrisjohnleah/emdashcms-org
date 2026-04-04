import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { searchPlugins } from "../../../../lib/db/queries";
import { parsePaginationParams } from "../../../../lib/api/pagination";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const category = url.searchParams.get("category") ?? null;
  const capability = url.searchParams.get("capability") ?? null;
  const sort = url.searchParams.get("sort") ?? "installs";
  const { cursor, limit } = parsePaginationParams(url);

  try {
    const results = await searchPlugins(env.DB, {
      query,
      category,
      capability,
      sort,
      cursor,
      limit,
    });
    return jsonResponse(results);
  } catch (err) {
    console.error("[api] Plugin search error:", err);
    return errorResponse(500, "Internal server error");
  }
};
