/**
 * Session cookie helpers for Astro request handling.
 *
 * The session cookie stores a signed JWT (from jwt.ts).
 * No server-side session storage — the cookie IS the session.
 */
import type { AstroCookies } from "astro";

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Set the session cookie with a signed JWT token.
 * httpOnly: prevents XSS access
 * secure: HTTPS only in production
 * sameSite lax: allows top-level navigations (OAuth redirects)
 * path /: available on all routes
 */
export function setSessionCookie(cookies: AstroCookies, token: string): void {
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

/**
 * Read the session token from the cookie, or null if absent.
 */
export function getSessionToken(cookies: AstroCookies): string | null {
  return cookies.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Extract a Bearer token from an `Authorization` header, or null if the
 * header is missing or doesn't use the Bearer scheme. Used to pick up
 * non-cookie sessions from CLI clients (e.g. the upstream `emdash` CLI).
 */
export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/**
 * Clear the session cookie (logout).
 */
export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: "lax",
  });
}
