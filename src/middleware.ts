import { defineMiddleware, sequence } from "astro:middleware";
import { env } from "cloudflare:workers";
import { verifySessionToken } from "./lib/auth/jwt";
import { getSessionToken } from "./lib/auth/session";
import { isProtectedRoute } from "./lib/auth/protected-routes";
import { checkRateLimit } from "./lib/downloads/rate-limit";
import { errorResponse } from "./lib/api/response";

/**
 * Security headers middleware.
 * Sets CSP, HSTS, X-Frame-Options, and other security headers on every response.
 */
const securityHeaders = defineMiddleware(async (_ctx, next) => {
  const response = await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' https://avatars.githubusercontent.com data:",
      "connect-src 'self'",
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  return response;
});

/**
 * CSRF protection middleware.
 * Validates Origin header on state-changing requests to dashboard and API routes.
 */
const csrfProtection = defineMiddleware(async ({ request, url }, next) => {
  if (request.method === "GET" || request.method === "HEAD") return next();

  // Webhook endpoints have their own HMAC authentication
  if (url.pathname.startsWith("/api/v1/webhooks/")) return next();

  const isMutationTarget =
    url.pathname.startsWith("/dashboard") ||
    url.pathname.startsWith("/api/v1/plugins") ||
    url.pathname.startsWith("/api/v1/themes");

  if (!isMutationTarget) return next();

  const origin = request.headers.get("origin");
  if (origin) {
    const allowedOrigins = import.meta.env.PROD
      ? ["https://emdashcms.org"]
      : ["http://localhost:4321", "http://localhost:8787"];

    if (!allowedOrigins.includes(origin)) {
      return new Response(
        JSON.stringify({ error: "CSRF validation failed" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  return next();
});

/**
 * Rate limiting middleware.
 * Per-IP rate limiting via D1. Exempts protected (authenticated)
 * write endpoints. Auth endpoints get a separate, more generous limit.
 */
const rateLimit = defineMiddleware(async ({ request, url }, next) => {
  if (isProtectedRoute(url.pathname, request.method)) {
    return next();
  }

  // Webhook endpoints are HMAC-authenticated, exempt from IP rate limiting
  if (url.pathname.startsWith("/api/v1/webhooks/")) return next();

  if (!url.pathname.startsWith("/api/")) {
    return next();
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

  // Auth endpoints get a separate, more generous limit (20/min)
  if (url.pathname.startsWith("/api/v1/auth/")) {
    const { allowed } = await checkRateLimit(env.DB, ip, 20);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Try again shortly." }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        },
      );
    }
    return next();
  }

  const { allowed } = await checkRateLimit(env.DB, ip, 60);

  if (!allowed) {
    return new Response(
      JSON.stringify({
        error: "Rate limit exceeded. Try again in 60 seconds.",
      }),
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

const auth = defineMiddleware(
  async ({ request, cookies, locals, url, redirect }, next) => {
    const token = getSessionToken(cookies);
    if (token) {
      try {
        const payload = await verifySessionToken(token);
        locals.author = {
          id: (payload.aid as string) ?? payload.sub,
          githubId: Number(payload.sub),
          username: payload.username,
        };
      } catch {
        cookies.delete("session", { path: "/" });
      }
    }

    if (isProtectedRoute(url.pathname, request.method) && !locals.author) {
      if (url.pathname.startsWith("/api/")) {
        return errorResponse(401, "Authentication required");
      }
      return redirect("/api/v1/auth/github", 302);
    }

    return next();
  },
);

export const onRequest = sequence(
  securityHeaders,
  csrfProtection,
  rateLimit,
  auth,
);
