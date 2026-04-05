/**
 * Utility functions for processing GitHub release tags.
 * Shared between the webhook endpoint and tests.
 */

/** Per D-08: tags containing these suffixes indicate pre-release versions */
const PRERELEASE_SUFFIXES = [
  "-beta",
  "-rc",
  "-dev",
  "-alpha",
  "-canary",
  "-next",
];

/**
 * Strip leading "v" prefix from a release tag to get the semver string.
 * Per D-11: version number extracted from release tag.
 *
 * @example extractVersion("v1.2.3") => "1.2.3"
 * @example extractVersion("1.2.3") => "1.2.3"
 */
export function extractVersion(tagName: string): string {
  return tagName.startsWith("v") ? tagName.slice(1) : tagName;
}

/**
 * Check if a release tag looks like a pre-release based on suffix patterns.
 * Per D-08: skip tags containing -beta, -rc, -dev, -alpha, -canary, -next.
 */
export function hasPrereleaseSuffix(tagName: string): boolean {
  const lower = tagName.toLowerCase();
  return PRERELEASE_SUFFIXES.some((s) => lower.includes(s));
}
