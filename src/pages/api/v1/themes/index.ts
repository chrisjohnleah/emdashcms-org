import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { searchThemes } from "../../../../lib/db/queries";
import { parsePaginationParams } from "../../../../lib/api/pagination";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";
import { resolveAuthorId } from "../../../../lib/publishing/plugin-queries";
import { registerTheme } from "../../../../lib/publishing/theme-queries";
import {
  isValidResourceId,
  validateUrlFields,
  validateKeywords,
  validateStringLengths,
  isBodyTooLarge,
} from "../../../../lib/api/validation";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const category = url.searchParams.get("category") ?? null;
  const keyword = url.searchParams.get("keyword") ?? null;
  const sort = url.searchParams.get("sort") ?? "created";
  const { cursor, limit } = parsePaginationParams(url);

  try {
    const results = await searchThemes(env.DB, {
      query,
      category,
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

export const POST: APIRoute = async ({ request, locals }) => {
  if (isBodyTooLarge(request)) return errorResponse(413, "Request body too large");

  try {
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    const body = (await request.json()) as Record<string, unknown>;

    if (!body.id || typeof body.id !== "string")
      return errorResponse(400, "Missing required field: id");
    if (!body.name || typeof body.name !== "string")
      return errorResponse(400, "Missing required field: name");
    if (!body.description || typeof body.description !== "string")
      return errorResponse(400, "Missing required field: description");

    // Validate theme ID format (same rules as plugins)
    if (!isValidResourceId(body.id)) {
      return errorResponse(
        400,
        "Invalid theme id format. Use lowercase alphanumeric with hyphens, optionally @scope/name",
      );
    }

    // Validate keywords if provided
    if (body.keywords !== undefined) {
      if (!Array.isArray(body.keywords))
        return errorResponse(400, "keywords must be an array");
      const kwErr = validateKeywords(body.keywords);
      if (kwErr) return errorResponse(400, kwErr);
    }

    // Validate URL schemes
    const urlFields = [
      "previewUrl",
      "demoUrl",
      "repositoryUrl",
      "homepageUrl",
    ];
    const badUrl = validateUrlFields(body, urlFields);
    if (badUrl) return errorResponse(400, `${badUrl} must be a valid http/https URL`);

    // Validate string lengths
    const lenErr = validateStringLengths(body);
    if (lenErr) return errorResponse(400, lenErr);

    await registerTheme(env.DB, authorId, {
      id: body.id,
      name: body.name,
      description: body.description,
      keywords: body.keywords as string[] | undefined,
      preview_url: body.previewUrl as string | undefined,
      demo_url: body.demoUrl as string | undefined,
      repository_url: body.repositoryUrl as string | undefined,
      homepage_url: body.homepageUrl as string | undefined,
      license: body.license as string | undefined,
    });

    return jsonResponse({ id: body.id }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) {
      return errorResponse(409, "Theme ID already exists");
    }
    console.error("[api] Theme registration error:", err);
    return errorResponse(500, "Internal server error");
  }
};
