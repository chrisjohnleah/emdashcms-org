import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse } from "../../../../lib/api/response";

export const prerender = false;

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

export const GET: APIRoute = async ({ params }) => {
  const key = params.key;

  if (!key) {
    return errorResponse(400, "Image key is required");
  }

  if (!key.startsWith("themes/")) {
    return errorResponse(403, "Forbidden");
  }

  // Prevent path traversal
  if (key.includes("..") || key.includes("//")) {
    return errorResponse(400, "Invalid key");
  }

  // Only serve known image file extensions
  if (!ALLOWED_EXTENSIONS.some((ext) => key.endsWith(ext))) {
    return errorResponse(403, "Forbidden");
  }

  try {
    const r2Object = await env.ARTIFACTS.get(key);

    if (!r2Object) {
      return errorResponse(404, "Image not found");
    }

    return new Response(r2Object.body, {
      headers: {
        "Content-Type":
          r2Object.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Length": String(r2Object.size),
        "Cache-Control": "public, max-age=3600",
        ETag: r2Object.httpEtag,
      },
    });
  } catch (err) {
    console.error("[api] Image proxy error:", err);
    return errorResponse(500, "Internal server error");
  }
};
