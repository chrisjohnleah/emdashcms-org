import { env } from "cloudflare:workers";

/**
 * Check whether a GitHub user ID belongs to a superadmin.
 * Admin IDs are configured via SUPERADMIN_GITHUB_IDS env var (comma-separated).
 */
export function isSuperAdmin(githubId: number): boolean {
  const raw = env.SUPERADMIN_GITHUB_IDS;
  if (!raw) return false;
  const ids = raw.split(",").map((s) => s.trim());
  return ids.includes(String(githubId));
}
