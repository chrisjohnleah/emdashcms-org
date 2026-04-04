import { defineMiddleware, sequence } from "astro:middleware";
import { verifySessionToken } from "./lib/auth/jwt";
import { getSessionToken } from "./lib/auth/session";
import { isProtectedRoute } from "./lib/auth/protected-routes";
import { errorResponse } from "./lib/api/response";

const auth = defineMiddleware(async ({ request, cookies, locals, url, redirect }, next) => {
  // Attempt to restore session from cookie
  const token = getSessionToken(cookies);
  if (token) {
    try {
      const payload = await verifySessionToken(token);
      locals.author = {
        id: payload.sub,
        githubId: Number(payload.sub),
        username: payload.username,
      };
    } catch {
      // Invalid/expired token — clear stale cookie
      cookies.delete("session", { path: "/" });
    }
  }

  // Enforce authentication on protected routes
  if (isProtectedRoute(url.pathname, request.method) && !locals.author) {
    if (url.pathname.startsWith("/api/")) {
      return errorResponse(401, "Authentication required");
    }
    // Dashboard pages redirect to OAuth login
    return redirect("/api/v1/auth/github", 302);
  }

  return next();
});

export const onRequest = sequence(auth);
