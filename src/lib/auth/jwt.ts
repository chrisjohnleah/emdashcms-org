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
  /** Internal D1 author UUID */
  aid: string;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

/**
 * Create a signed JWT session token for an authenticated author.
 * Token expires in 7 days (matching session cookie maxAge).
 *
 * - `sub`: GitHub numeric ID (string)
 * - `aid`: Internal D1 author UUID
 * - `iss`/`aud`: emdashcms.org to prevent token confusion
 */
export async function createSessionToken(
  authorId: string,
  githubId: number,
  username: string,
): Promise<string> {
  return new SignJWT({ username, aid: authorId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(githubId))
    .setIssuer("emdashcms.org")
    .setAudience("emdashcms.org")
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
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: "emdashcms.org",
    audience: "emdashcms.org",
  });
  return payload as SessionPayload;
}
