import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getThemeDetail } from "../../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";
import { resolveAuthorId } from "../../../../../lib/publishing/plugin-queries";
import {
  updateThemeMetadata,
} from "../../../../../lib/publishing/theme-queries";
import type { UpdateThemeMetadataInput } from "../../../../../lib/publishing/theme-queries";
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
    return errorResponse(400, "Theme ID is required");
  }

  try {
    const theme = await getThemeDetail(env.DB, id);

    if (!theme) {
      return errorResponse(404, "Theme not found");
    }

    return jsonResponse(theme);
  } catch (err) {
    console.error("[api] Theme detail error:", err);
    return errorResponse(500, "Internal server error");
  }
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const id = params.id;
  if (!id) return errorResponse(400, "Theme ID is required");
  if (isBodyTooLarge(request)) return errorResponse(413, "Request body too large");

  try {
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    const access = await checkPluginAccess(env.DB, authorId, id);
    if (!access.found) return errorResponse(404, "Theme not found");
    if (!access.role || !hasRole(access.role, "maintainer"))
      return errorResponse(403, "Not authorized to edit this theme");

    const body = (await request.json()) as Record<string, unknown>;

    const updateInput: UpdateThemeMetadataInput = {};
    const allowedStringFields = [
      "shortDescription",
      "description",
      "category",
      "previewUrl",
      "demoUrl",
      "repositoryUrl",
      "homepageUrl",
      "license",
    ] as const;

    for (const field of allowedStringFields) {
      if (field in body) {
        if (body[field] !== null && typeof body[field] !== "string") {
          return errorResponse(400, `${field} must be a string or null`);
        }
        (updateInput as Record<string, unknown>)[field] = body[field];
      }
    }

    // Validate URL schemes on any URL fields being updated
    const urlFields = [
      "previewUrl",
      "demoUrl",
      "repositoryUrl",
      "homepageUrl",
    ];
    const badUrl = validateUrlFields(
      updateInput as Record<string, unknown>,
      urlFields,
    );
    if (badUrl) return errorResponse(400, `${badUrl} must be a valid http/https URL`);

    // Validate string lengths
    const lenErr = validateStringLengths(
      updateInput as Record<string, unknown>,
    );
    if (lenErr) return errorResponse(400, lenErr);

    if ("keywords" in body) {
      if (!Array.isArray(body.keywords)) {
        return errorResponse(400, "keywords must be an array of strings");
      }
      const kwErr = validateKeywords(body.keywords);
      if (kwErr) return errorResponse(400, kwErr);
      updateInput.keywords = body.keywords as string[];
    }

    await updateThemeMetadata(env.DB, id, updateInput);

    return jsonResponse({ id }, 200);
  } catch (err) {
    console.error("[api] Theme update error:", err);
    return errorResponse(500, "Internal server error");
  }
};
