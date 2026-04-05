/**
 * Protected route definitions for auth middleware.
 *
 * Pure function — no Astro imports, fully testable in vitest.
 * Write endpoints require authentication; read (GET) endpoints are public.
 * Dashboard pages always require authentication.
 */

interface ProtectedPattern {
  path: string;
  methods: string[];
}

export const PROTECTED_PATTERNS: ProtectedPattern[] = [
  { path: "/api/v1/plugins", methods: ["POST", "PUT", "PATCH", "DELETE"] },
  { path: "/api/v1/themes", methods: ["POST", "PUT", "PATCH", "DELETE"] },
  { path: "/api/v1/github", methods: ["GET", "POST"] },
  { path: "/dashboard", methods: ["GET", "POST"] },
];

/**
 * Check whether a given route + method combination requires authentication.
 * Uses startsWith matching so /api/v1/plugins/my-plugin/versions is covered
 * by the /api/v1/plugins pattern.
 */
export function isProtectedRoute(pathname: string, method: string): boolean {
  const upperMethod = method.toUpperCase();
  return PROTECTED_PATTERNS.some(
    (pattern) =>
      pathname.startsWith(pattern.path) && pattern.methods.includes(upperMethod),
  );
}
