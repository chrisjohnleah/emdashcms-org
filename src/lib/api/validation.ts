/**
 * Shared input validation utilities for API routes.
 */

/** Validate a user-supplied URL has an http/https scheme. */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validate URL fields in a record. Returns the first invalid field name, or null. */
export function validateUrlFields(
  data: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const field of fields) {
    const value = data[field];
    if (typeof value === "string" && value !== "" && !isValidUrl(value)) {
      return field;
    }
  }
  return null;
}

/** ID format: lowercase alphanumeric with hyphens, optionally @scope/name */
const ID_REGEX = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;

export function isValidResourceId(id: string): boolean {
  return ID_REGEX.test(id);
}

/** Validate keywords array elements. */
export function validateKeywords(
  keywords: unknown[],
): string | null {
  if (keywords.length > 20) return "Maximum 20 keywords allowed";
  for (const k of keywords) {
    if (typeof k !== "string") return "Each keyword must be a string";
    if (k.length > 50) return "Each keyword must be 50 characters or less";
  }
  return null;
}

/** Max lengths for common string fields. */
const STRING_LIMITS: Record<string, number> = {
  name: 100,
  short_description: 150,
  shortDescription: 150,
  description: 5000,
  license: 50,
  repositoryUrl: 2048,
  homepageUrl: 2048,
  supportUrl: 2048,
  fundingUrl: 2048,
  previewUrl: 2048,
  demoUrl: 2048,
  repository_url: 2048,
  homepage_url: 2048,
  support_url: 2048,
  funding_url: 2048,
  preview_url: 2048,
  demo_url: 2048,
};

/** Known plugin and theme categories. */
export const KNOWN_CATEGORIES = [
  "content",
  "media",
  "seo",
  "analytics",
  "security",
  "performance",
  "integration",
  "workflow",
  "developer-tools",
  "ui",
] as const;

export type KnownCategory = (typeof KNOWN_CATEGORIES)[number];

/** Validate a category against known values. Returns error string or null. */
export function validateCategory(category: string): string | null {
  if (!KNOWN_CATEGORIES.includes(category as KnownCategory)) {
    return `Invalid category: ${category}. Must be one of: ${KNOWN_CATEGORIES.join(", ")}`;
  }
  return null;
}

/** Validate string field lengths. Returns first error or null. */
export function validateStringLengths(
  data: Record<string, unknown>,
): string | null {
  for (const [field, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    const max = STRING_LIMITS[field];
    if (max && value.length > max) {
      return `${field} must be ${max} characters or less`;
    }
  }
  return null;
}

/** Known plugin capabilities. */
const KNOWN_CAPABILITIES = new Set([
  "network:fetch",
  "storage:read",
  "storage:write",
  "admin:panel",
  "content:transform",
  "hook:beforeSave",
  "hook:afterSave",
]);

/** Validate capabilities array against known values. */
export function validateCapabilities(caps: unknown[]): string | null {
  for (const c of caps) {
    if (typeof c !== "string" || !KNOWN_CAPABILITIES.has(c)) {
      return `Invalid capability: ${String(c)}`;
    }
  }
  return null;
}

/** Check Content-Length header and reject oversized JSON bodies. */
export function isBodyTooLarge(
  request: Request,
  maxBytes = 64 * 1024,
): boolean {
  const cl = Number(request.headers.get("content-length") ?? 0);
  return cl > maxBytes;
}
