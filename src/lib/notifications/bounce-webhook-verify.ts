/**
 * HMAC-SHA256 signature verification for Unosend bounce webhooks.
 *
 * Mirrors src/lib/github/webhook-verify.ts exactly: uses the same
 * `crypto.subtle.importKey` + `sign` + `timingSafeEqual` pipeline, with
 * the only shape difference being the `X-Unosend-Signature: sha256=<hex>`
 * header format (identical to GitHub's `X-Hub-Signature-256` on the wire).
 *
 * CRITICAL: Must be called on the raw request body string BEFORE
 * `JSON.parse`. JSON parsing normalises whitespace and key order which
 * breaks HMAC verification.
 *
 * Docs:
 *  - https://docs.unosend.co/guides/webhooks.md — "X-Unosend-Signature: sha256={hexdigest}"
 */

/**
 * Verify an Unosend webhook signature.
 *
 * Rejects early on structural issues (null header, wrong prefix, wrong
 * hex length) so a timing attack can't distinguish "bad format" from
 * "bad signature" via a timing oracle — the expensive HMAC step only
 * runs once the outer shape is valid.
 *
 * @param rawBody  Raw request body text (NOT `JSON.parse`d).
 * @param signatureHeader  The `X-Unosend-Signature` header value (may be `null`).
 * @param secret  The `UNOSEND_WEBHOOK_SECRET` env value.
 * @returns `true` if the signature validates, `false` otherwise.
 */
export async function verifyUnosendSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  // SHA-256 hex is always 64 chars. Reject anything else without running
  // the expensive HMAC operation.
  const hexPart = signatureHeader.slice("sha256=".length);
  if (hexPart.length !== 64) return false;

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
    encoder.encode(rawBody),
  );
  const expectedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `sha256=${expectedHex}`;

  if (expected.length !== signatureHeader.length) return false;

  const a = encoder.encode(expected);
  const b = encoder.encode(signatureHeader);
  // timingSafeEqual is a Cloudflare Workers extension to SubtleCrypto.
  return (
    crypto.subtle as SubtleCrypto & {
      timingSafeEqual(a: BufferSource, b: BufferSource): boolean;
    }
  ).timingSafeEqual(a, b);
}
