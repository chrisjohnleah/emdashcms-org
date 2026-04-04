/**
 * Normalize a D1 timestamp to ISO 8601 format.
 *
 * D1's datetime('now') produces "YYYY-MM-DD HH:MM:SS" while
 * strftime('%Y-%m-%dT%H:%M:%SZ', 'now') produces "YYYY-MM-DDTHH:MM:SSZ".
 * This function normalizes both formats to the ISO 8601 form expected by
 * the MarketplaceClient API contract (D-25).
 */
export function toISOTimestamp(timestamp: string): string {
  if (timestamp.includes("T") && timestamp.endsWith("Z")) {
    return timestamp;
  }
  return timestamp.replace(" ", "T") + "Z";
}
