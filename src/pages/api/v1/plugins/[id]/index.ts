import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getPluginDetail } from "../../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";
import {
  resolveAuthorId,
  updatePluginMetadata,
} from "../../../../../lib/publishing/plugin-queries";
import { checkPluginAccess, hasRole } from "../../../../../lib/auth/permissions";
import {
  validateUrlFields,
  validateKeywords,
  validateStringLengths,
  isBodyTooLarge,
} from "../../../../../lib/api/validation";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;

  if (!id) {
    return errorResponse(400, "Plugin ID is required");
  }

  try {
    const plugin = await getPluginDetail(env.DB, id);

    if (!plugin) {
      return errorResponse(404, "Plugin not found");
    }

    return jsonResponse(plugin);
  } catch (err) {
    console.error("[api] Plugin detail error:", err);
    return errorResponse(500, "Internal server error");
  }
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const pluginId = params.id;
  if (!pluginId) return errorResponse(400, "Plugin ID is required");
  if (isBodyTooLarge(request)) return errorResponse(413, "Request body too large");

  try {
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    const access = await checkPluginAccess(env.DB, authorId, pluginId);
    if (!access.found) return errorResponse(404, "Plugin not found");
    if (!access.role || !hasRole(access.role, "maintainer"))
      return errorResponse(403, "Not authorized to edit this plugin");

    const body = (await request.json()) as Record<string, unknown>;

    const updateData: Record<string, unknown> = {};
    const allowedStringFields = [
      "description",
      "repositoryUrl",
      "homepageUrl",
      "supportUrl",
      "fundingUrl",
      "license",
    ];

    for (const field of allowedStringFields) {
      if (field in body) {
        if (body[field] !== null && typeof body[field] !== "string") {
          return errorResponse(400, `${field} must be a string or null`);
        }
        updateData[field] = body[field];
      }
    }

    // Validate URL schemes on any URL fields being updated
    const urlFields = [
      "repositoryUrl",
      "homepageUrl",
      "supportUrl",
      "fundingUrl",
    ];
    const badUrl = validateUrlFields(updateData, urlFields);
    if (badUrl) return errorResponse(400, `${badUrl} must be a valid http/https URL`);

    // Validate string lengths
    const lenErr = validateStringLengths(updateData);
    if (lenErr) return errorResponse(400, lenErr);

    if ("keywords" in body) {
      if (!Array.isArray(body.keywords)) {
        return errorResponse(400, "keywords must be an array of strings");
      }
      const kwErr = validateKeywords(body.keywords);
      if (kwErr) return errorResponse(400, kwErr);
      updateData.keywords = body.keywords;
    }

    await updatePluginMetadata(
      env.DB,
      pluginId,
      updateData as Parameters<typeof updatePluginMetadata>[2],
    );

    return jsonResponse({ message: "Plugin updated" });
  } catch (err) {
    console.error("[api] Plugin update error:", err);
    return errorResponse(500, "Internal server error");
  }
};
