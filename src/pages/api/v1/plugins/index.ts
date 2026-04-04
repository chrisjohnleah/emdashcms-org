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
  try {
    // Resolve GitHub ID to internal author UUID (D-17 clarification)
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    // Parse request body
    const body = (await request.json()) as Record<string, unknown>;

    // Validate required fields (D-02)
    const id = body.id;
    const name = body.name;
    const description = body.description;
    const capabilities = body.capabilities;

    if (!id || typeof id !== "string")
      return errorResponse(400, "id is required");
    if (!name || typeof name !== "string")
      return errorResponse(400, "name is required");
    if (!description || typeof description !== "string")
      return errorResponse(400, "description is required");
    if (!Array.isArray(capabilities))
      return errorResponse(400, "capabilities must be an array");

    // Validate id format (D-01: lowercase alphanumeric with hyphens, optionally @scope/name)
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(id)) {
      return errorResponse(
        400,
        "Invalid plugin id format. Use lowercase alphanumeric with hyphens, optionally @scope/name",
      );
    }

    // Check plugin id not already taken
    const existing = await getPluginOwner(env.DB, id);
    if (existing)
      return errorResponse(409, `Plugin id '${id}' is already registered`);

    // Register plugin
    await registerPlugin(env.DB, authorId, {
      id,
      name,
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
