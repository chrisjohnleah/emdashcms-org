/**
 * Public SVG badge endpoint (D-01):
 *   GET /badges/v1/plugin/:id/:metric.svg
 *
 * Thin shim around `handleBadgeRequest` — all real logic lives in
 * `src/lib/badges/handler.ts` so it can be exercised by integration
 * tests (the test worker entry does not run the Astro router).
 */

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handleBadgeRequest } from "../../../../../lib/badges/handler";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  return handleBadgeRequest(request, env);
};
