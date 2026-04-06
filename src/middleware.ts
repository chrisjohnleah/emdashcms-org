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
 * Fails closed: requests with no Origin header on a mutation target are rejected.
 */
const csrfProtection = defineMiddleware(async ({ request, url }, next) => {
  if (request.method === "GET" || request.method === "HEAD") return next();

  // Webhook endpoints have their own HMAC authentication
  if (url.pathname.startsWith("/api/v1/webhooks/")) return next();

  // Device code flow is for non-browser clients (CLI). It uses a short-lived
  // user_code and HMAC-style token exchange — no cookies, no CSRF surface.
  if (url.pathname.startsWith("/api/v1/auth/device/")) return next();

  const isMutationTarget =
    url.pathname.startsWith("/dashboard") ||
    url.pathname.startsWith("/api/v1/plugins") ||
    url.pathname.startsWith("/api/v1/themes") ||
    url.pathname.startsWith("/api/v1/admin") ||
    url.pathname.startsWith("/api/v1/auth") ||
    url.pathname.startsWith("/api/v1/github") ||
    url.pathname.startsWith("/plugins/") ||
    url.pathname.startsWith("/themes/");

  if (!isMutationTarget) return next();

  const allowedOrigins = import.meta.env.PROD
    ? ["https://emdashcms.org"]
    : ["http://localhost:4321", "http://localhost:8787"];

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // Fail closed: a mutation request must include either Origin or Referer
  // matching an allowed origin. Most browsers always send one of the two
  // on POST/PUT/PATCH/DELETE; clients that omit both are not legitimate
  // browser sessions.
  let validated = false;
  if (origin) {
    if (!allowedOrigins.includes(origin)) {
      return new Response(
        JSON.stringify({ error: "CSRF validation failed" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    validated = true;
  } else if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (!allowedOrigins.includes(refererOrigin)) {
        return new Response(
          JSON.stringify({ error: "CSRF validation failed" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      validated = true;
    } catch {
      // Malformed Referer — fall through to rejection
    }
  }

  if (!validated) {
    return new Response(
      JSON.stringify({ error: "Missing Origin or Referer header" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  return next();
});

/**
 * Rate limiting middleware.
 *
 * First line: Cloudflare's native rate limit binding — counters live in
 * the edge node's local cache, never touch D1, and reject abusive IPs
 * before any further work. Free on Workers free tier.
 *
 * Fallback: the D1 checkRateLimit function, used when the binding is
 * unavailable (local dev / tests). The D1 path is also still useful for
 * authenticated per-author limits applied inside route handlers.
 */
const rateLimitResponse = () =>
  new Response(
    JSON.stringify({ error: "Rate limit exceeded. Try again in 60 seconds." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
      },
    },
  );

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
  const isAuth = url.pathname.startsWith("/api/v1/auth/");

  // Try the native binding first. Cached at the edge — no D1 hit.
  const binding = isAuth ? env.AUTH_RATE_LIMITER : env.GENERAL_RATE_LIMITER;
  if (binding) {
    try {
      const { success } = await binding.limit({ key: ip });
      if (!success) return rateLimitResponse();
      return next();
    } catch (err) {
      console.error("[ratelimit] binding failed, falling back to D1:", err);
    }
  }

  // Fallback: D1-backed rate limiter (dev / tests / binding outage)
  const threshold = isAuth ? 20 : 60;
  const { allowed } = await checkRateLimit(env.DB, ip, threshold);
  if (!allowed) return rateLimitResponse();

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
