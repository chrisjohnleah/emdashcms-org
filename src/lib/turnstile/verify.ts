/**
 * Server-side Cloudflare Turnstile token verification.
 * Validates challenge tokens against the Turnstile siteverify API.
 */

const VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
}

export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<TurnstileResult> {
  if (!token) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as {
      success: boolean;
      "error-codes"?: string[];
    };
    return {
      success: data.success,
      errorCodes: data["error-codes"] ?? [],
    };
  } catch {
    return { success: false, errorCodes: ["fetch-error"] };
  }
}
