import type { APIRoute } from "astro";
import { clearSessionCookie } from "../../../../lib/auth/session";
import { jsonResponse } from "../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  clearSessionCookie(cookies);
  return jsonResponse({ ok: true });
};
