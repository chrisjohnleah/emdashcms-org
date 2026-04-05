import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getThemeDetail } from "../../../../lib/db/queries";
import { jsonResponse, errorResponse } from "../../../../lib/api/response";
import { resolveAuthorId } from "../../../../lib/publishing/plugin-queries";
import {
  getThemeOwner,
  updateThemeMetadata,
} from "../../../../lib/publishing/theme-queries";
import type { UpdateThemeMetadataInput } from "../../../../lib/publishing/theme-queries";

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

  try {
    const authorId = await resolveAuthorId(env.DB, locals.author!.githubId);
    if (!authorId) return errorResponse(401, "Author not found");

    const owner = await getThemeOwner(env.DB, id);
    if (!owner) return errorResponse(404, "Theme not found");
    if (owner.authorId !== authorId) return errorResponse(403, "Forbidden");

    const body = (await request.json()) as Record<string, unknown>;

    const updateInput: UpdateThemeMetadataInput = {};
    const allowedStringFields = [
      "description",
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

    if ("keywords" in body) {
      if (!Array.isArray(body.keywords)) {
        return errorResponse(400, "keywords must be an array of strings");
      }
      updateInput.keywords = body.keywords as string[];
    }

    await updateThemeMetadata(env.DB, id, updateInput);

    return jsonResponse({ id }, 200);
  } catch (err) {
    console.error("[api] Theme update error:", err);
    return errorResponse(500, "Internal server error");
  }
};
