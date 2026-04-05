import { defineMiddleware, sequence } from "astro:middleware";
import { env } from "cloudflare:workers";
import { verifySessionToken } from "./lib/auth/jwt";
import { getSessionToken } from "./lib/auth/session";
import { isProtectedRoute } from "./lib/auth/protected-routes";
import { checkRateLimit } from "./lib/downloads/rate-limit";
import { errorResponse } from "./lib/api/response";

/**
 * Rate limiting middleware (D-15, D-16).
 * Runs before auth to count requests early. Exempts protected (authenticated)
 * write endpoints and auth routes — those have their own per-author limits.
 * Non-API routes (pages, assets) are also exempt.
 */
const rateLimit = defineMiddleware(async ({ request, url }, next) => {
  // Protected (authenticated) routes are exempt from rate limiting (D-16)
  if (isProtectedRoute(url.pathname, request.method)) {
    return next();
  }

  // Skip rate limiting for non-API routes (pages, assets, etc.)
  if (!url.pathname.startsWith("/api/")) {
    return next();
  }

  // Skip auth endpoints (D-16)
  if (url.pathname.startsWith("/api/v1/auth/")) {
    return next();
  }

  const { allowed } = await checkRateLimit(env.DB);

  if (!allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Try again in 60 seconds." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      },
    );
  }

  return next();
});

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

export const onRequest = sequence(rateLimit, auth);
