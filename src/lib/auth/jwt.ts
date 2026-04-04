/**
 * JWT session token sign/verify using jose HS256.
 *
 * Environment secrets required:
 *   JWT_SECRET - minimum 32 character hex string
 *   Set via: wrangler secret put JWT_SECRET
 *   In dev:  add to .dev.vars (gitignored)
 *   Generate: openssl rand -hex 32
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { env } from "cloudflare:workers";

export interface SessionPayload extends JWTPayload {
  sub: string;
  username: string;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

/**
 * Create a signed JWT session token for an authenticated author.
 * Token expires in 7 days (matching session cookie maxAge).
 */
export async function createSessionToken(
  githubId: number,
  username: string,
): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(githubId))
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

/**
 * Verify a session JWT and return the decoded payload.
 * Throws on expired, tampered, or invalid tokens.
 */
export async function verifySessionToken(
  token: string,
): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  return payload as SessionPayload;
}
