import type { APIRoute } from "astro";
import { buildOpenApiDocument } from "../../../lib/agents/openapi";

export const prerender = false;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(buildOpenApiDocument()), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.oai.openapi+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
};
