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
 * Dev: http://localhost:4321/api/auth/callback
 * Prod: https://emdashcms.org/api/auth/callback
 */
export function getCallbackUrl(): string {
  return import.meta.env.PROD
    ? "https://emdashcms.org/api/auth/callback"
    : "http://localhost:4321/api/auth/callback";
}

/**
 * Exchange an authorization code for a GitHub access token (web flow step 2).
 * Returns the access token string, or null if the exchange fails.
 */
export async function exchangeCodeForToken(
  code: string,
): Promise<string | null> {
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
        redirect_uri: getCallbackUrl(),
      }),
    },
  );

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
  };
  return data.access_token ?? null;
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
      scope: "read:user",
    }),
  });

  if (!response.ok) return null;

  return (await response.json()) as DeviceCodeResponse;
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
 * On first login: creates with crypto.randomUUID(), verified=0.
 * On subsequent logins: updates github_username, avatar_url, updated_at.
 * Returns the author's internal UUID.
 */
export async function upsertAuthor(user: GitHubUser): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM authors WHERE github_id = ?",
  )
    .bind(user.id)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      "UPDATE authors SET github_username = ?, avatar_url = ?, updated_at = datetime('now') WHERE github_id = ?",
    )
      .bind(user.login, user.avatar_url, user.id)
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO authors (id, github_id, github_username, avatar_url) VALUES (?, ?, ?, ?)",
  )
    .bind(id, user.id, user.login, user.avatar_url)
    .run();
  return id;
}
