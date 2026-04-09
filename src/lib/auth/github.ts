/**
 * GitHub OAuth HTTP calls (web flow + device flow) and D1 author upsert.
 *
 * All functions use raw fetch() to GitHub's OAuth and API endpoints.
 * No OAuth library needed — the flows are simple HTTP exchanges.
 */
import { env } from "cloudflare:workers";

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token?: string;
  error?:
    | "authorization_pending"
    | "slow_down"
    | "expired_token"
    | "access_denied";
}

/**
 * Returns the OAuth callback URL based on environment.
 * Dev: http://localhost:4321/api/v1/auth/callback
 * Prod: https://emdashcms.org/api/v1/auth/callback
 */
export function getCallbackUrl(): string {
  return import.meta.env.PROD
    ? "https://emdashcms.org/api/v1/auth/callback"
    : "http://localhost:4321/api/v1/auth/callback";
}

/**
 * Exchange an authorization code for a GitHub access token (web flow step 2).
 * Returns the access token string, or null if the exchange fails.
 *
 * On failure, logs the GitHub error response (status, error code, description,
 * and the redirect_uri we sent) so the actual root cause is visible in the
 * Workers log instead of being swallowed into a generic 502.
 */
export async function exchangeCodeForToken(
  code: string,
): Promise<string | null> {
  const redirectUri = getCallbackUrl();
  const response = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    error_uri?: string;
  };

  if (!data.access_token) {
    const clientIdPrefix = env.GITHUB_CLIENT_ID
      ? `${env.GITHUB_CLIENT_ID.slice(0, 8)}...`
      : "missing";
    console.error(
      `[auth] GitHub code exchange failed: status=${response.status} error=${data.error ?? "unknown"} description=${data.error_description ?? "none"} uri=${data.error_uri ?? "none"} sent_redirect_uri=${redirectUri} client_id_prefix=${clientIdPrefix}`,
    );
    return null;
  }

  return data.access_token;
}

/**
 * Fetch the authenticated GitHub user's profile.
 * Returns the user object, or null on failure.
 */
export async function fetchGitHubUser(
  accessToken: string,
): Promise<GitHubUser | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "emdashcms-org",
    },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    id: number;
    login: string;
    avatar_url: string | null;
  };
  return { id: data.id, login: data.login, avatar_url: data.avatar_url };
}

/**
 * Request a device code from GitHub for the device flow (CLI auth step 1).
 * Returns the device code response, or null on failure.
 *
 * Scope is `read:user user:email` (Phase 12 NOTF-04): `user:email` is
 * additive to `read:user` — per GitHub's docs, `read:user` does NOT include
 * the private email address, so we must request both. Existing sessions
 * stay valid because this project discards the GitHub access token
 * immediately and runs its own JWT session.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse | null> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      scope: "read:user user:email",
    }),
  });

  if (!response.ok) return null;

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Single entry from `GET /user/emails`.
 */
export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

/**
 * Pick the first verified primary email from a `/user/emails` response,
 * filtering out `@users.noreply.github.com` (Pitfall 4 in 12-RESEARCH.md).
 *
 * Noreply addresses look valid to the API but are undeliverable for
 * inbound mail — sending to them triggers an instant hard bounce that
 * would leave a new publisher stranded on their very first notification.
 */
export function pickPublishableEmail(
  emails: GitHubEmail[],
): string | null {
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) return null;
  if (primary.email.endsWith("@users.noreply.github.com")) return null;
  return primary.email;
}

/**
 * Fetch the primary verified email for the authenticated user via
 * `GET /user/emails`. Requires the `user:email` OAuth scope.
 *
 * Returns `null` when:
 *   - the API returns non-OK (permission denied, rate limited, etc.)
 *   - no primary verified email is present
 *   - the primary is a noreply address (filtered by `pickPublishableEmail`)
 */
export async function fetchPrimaryEmail(
  accessToken: string,
): Promise<string | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "emdashcms-org",
    },
  });

  if (!response.ok) return null;

  const emails = (await response.json()) as GitHubEmail[];
  return pickPublishableEmail(emails);
}

/**
 * Exchange a device code for an access token (CLI auth polling step).
 * Returns the full response — caller checks for access_token or error field.
 */
export async function exchangeDeviceCode(
  deviceCode: string,
): Promise<DeviceTokenResponse> {
  const response = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
  );

  return (await response.json()) as DeviceTokenResponse;
}

/**
 * Create or update an author record in D1 after GitHub OAuth.
 *
 * On first login: creates with `crypto.randomUUID()`, verified=0,
 * and the pulled email (or null if unavailable / noreply-filtered).
 *
 * On subsequent logins: always refreshes `github_username` and
 * `avatar_url`. The email column is only touched when we have a new
 * non-null value AND it differs from the stored one — in which case
 * we ALSO clear `email_bounced_at` (a fresh re-sync from GitHub is
 * user intent to reset the bounce flag).
 *
 * The `email` parameter defaults to `null` so pre-Phase-12 callers
 * (existing tests, admin seeding, etc.) continue to work unchanged —
 * they upsert with NULL email, which is the correct "no GitHub email
 * available" state.
 */
export async function upsertAuthor(
  user: GitHubUser,
  email: string | null = null,
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id, email FROM authors WHERE github_id = ?",
  )
    .bind(user.id)
    .first<{ id: string; email: string | null }>();

  if (existing) {
    // Only overwrite stored email when we received a new non-null value
    // that differs from what's on file. Don't clobber a good address
    // because a later login failed to pull a fresh one.
    if (email && email !== existing.email) {
      await env.DB.prepare(
        `UPDATE authors
         SET github_username = ?, avatar_url = ?, email = ?, email_bounced_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE github_id = ?`,
      )
        .bind(user.login, user.avatar_url, email, user.id)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE authors SET github_username = ?, avatar_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE github_id = ?",
      )
        .bind(user.login, user.avatar_url, user.id)
        .run();
    }
    return existing.id;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO authors (id, github_id, github_username, avatar_url, email) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, user.login, user.avatar_url, email)
    .run();
  return id;
}

/**
 * Return the ban status for an author (by internal UUID). Used by the OAuth
 * callback and the plugin/theme registration endpoints to refuse publishing
 * from banned accounts. Banned authors can still view the site; this check
 * gates writes and session creation only.
 */
export async function isAuthorBanned(
  db: D1Database,
  authorId: string,
): Promise<{ banned: boolean; reason: string | null }> {
  const row = await db
    .prepare(
      "SELECT banned, banned_reason FROM authors WHERE id = ?",
    )
    .bind(authorId)
    .first<{ banned: number; banned_reason: string | null }>();

  if (!row || row.banned !== 1) {
    return { banned: false, reason: null };
  }
  return { banned: true, reason: row.banned_reason ?? null };
}
