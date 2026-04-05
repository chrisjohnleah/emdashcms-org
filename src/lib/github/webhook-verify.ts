/**
 * Verify a GitHub webhook delivery HMAC-SHA256 signature.
 * Per D-12: webhook endpoint is public, verified by HMAC, not auth middleware.
 *
 * CRITICAL: Must be called on the raw request body string BEFORE JSON.parse.
 * JSON parsing normalizes whitespace/key order which breaks HMAC verification.
 *
 * @param payload - Raw request body text (NOT parsed JSON)
 * @param signatureHeader - Value of X-Hub-Signature-256 header (format: "sha256=<hex>")
 * @param secret - GITHUB_WEBHOOK_SECRET env var
 * @returns true if signature is valid
 */
export async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  const expectedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `sha256=${expectedHex}`;

  if (expected.length !== signatureHeader.length) return false;
  const a = encoder.encode(expected);
  const b = encoder.encode(signatureHeader);
  // timingSafeEqual is a Cloudflare Workers extension to SubtleCrypto
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: BufferSource, b: BufferSource): boolean }).timingSafeEqual(a, b);
}
