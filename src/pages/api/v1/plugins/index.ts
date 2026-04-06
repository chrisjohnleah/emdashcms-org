import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { searchPlugins } from "../../../../lib/db/queries";
import { parsePaginationParams } from "../../../../lib/api/pagination";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";
import {
  resolveAuthorId,
  registerPlugin,
  getPluginOwner,
} from "../../../../lib/publishing/plugin-queries";
import {
  isValidResourceId,
  validateUrlFields,
  validateKeywords,
  validateCapabilities,
  validateStringLengths,
  isBodyTooLarge,
} from "../../../../lib/api/validation";

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

export const POST: APIRoute = async ({ request, locals }) => {
  if (isBodyTooLarge(request)) return errorResponse(413, "Request body too large");

  try {
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    const body = (await request.json()) as Record<string, unknown>;

    const id = body.id;
    const name = body.name;
    const description = body.description;
    // Capabilities are optional — if not provided, the plugin starts with []
    // and the audit worker populates them when the first version's bundle
    // is validated against the manifest schema.
    const capabilities = body.capabilities ?? [];

    if (!id || typeof id !== "string")
      return errorResponse(400, "id is required");
    if (!name || typeof name !== "string")
      return errorResponse(400, "name is required");
    if (!description || typeof description !== "string")
      return errorResponse(400, "description is required");
    if (!Array.isArray(capabilities))
      return errorResponse(400, "capabilities must be an array");

    if (!isValidResourceId(id)) {
      return errorResponse(
        400,
        "Invalid plugin id format. Use lowercase alphanumeric with hyphens (e.g. my-plugin)",
      );
    }

    // Validate capabilities against known upstream values (when provided)
    if (capabilities.length > 0) {
      const capsErr = validateCapabilities(capabilities);
      if (capsErr) return errorResponse(400, capsErr);
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
      "repository_url",
      "homepage_url",
      "support_url",
      "funding_url",
    ];
    const badUrl = validateUrlFields(body, urlFields);
    if (badUrl) return errorResponse(400, `${badUrl} must be a valid http/https URL`);

    // Validate string lengths
    const lenErr = validateStringLengths(body);
    if (lenErr) return errorResponse(400, lenErr);

    const existing = await getPluginOwner(env.DB, id);
    if (existing)
      return errorResponse(409, `Plugin id '${id}' is already registered`);

    await registerPlugin(env.DB, authorId, {
      id,
      name,
      short_description: body.short_description as string | undefined,
      description,
      capabilities: capabilities as string[],
      keywords: body.keywords as string[] | undefined,
      license: body.license as string | undefined,
      category: body.category as string | undefined,
      repository_url: body.repository_url as string | undefined,
      homepage_url: body.homepage_url as string | undefined,
      support_url: body.support_url as string | undefined,
      funding_url: body.funding_url as string | undefined,
    });

    return jsonResponse({ id, message: "Plugin registered" }, 201);
  } catch (err) {
    console.error("[api] Plugin registration error:", err);
    return errorResponse(500, "Internal server error");
  }
};
