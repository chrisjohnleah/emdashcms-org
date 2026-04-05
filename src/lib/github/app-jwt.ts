import { SignJWT, importPKCS8 } from "jose";

/**
 * Normalize a PEM key that may have escaped newlines (from .dev.vars).
 * Production secrets via `wrangler secret put` preserve real newlines.
 */
function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/**
 * Generate a short-lived RS256 JWT to authenticate as the GitHub App.
 * The JWT is used to request installation access tokens.
 *
 * @param appId - The GitHub App's client ID (per D-01, use GITHUB_CLIENT_ID)
 * @param privateKeyPem - RSA private key in PKCS#8 PEM format
 * @returns Signed JWT string valid for 10 minutes
 */
export async function createAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const privateKey = await importPKCS8(normalizePem(privateKeyPem), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 600)
    .sign(privateKey);
}
