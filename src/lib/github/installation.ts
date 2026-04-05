import { createAppJwt } from "./app-jwt";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "emdashcms-org";

/**
 * Fetch a short-lived installation access token from GitHub.
 * Per D-19: fresh token on each call, no caching.
 * Per D-22: token is scoped to repos the publisher granted.
 */
export async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const appJwt = await createAppJwt(appId, privateKeyPem);
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
}

/**
 * List repositories accessible to an installation.
 * Per D-15: used to populate the repo selection dropdown.
 */
export async function listInstallationRepos(
  installationToken: string,
): Promise<GitHubRepo[]> {
  const res = await fetch(`${GITHUB_API}/installation/repositories`, {
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    repositories: Array<{
      id: number;
      full_name: string;
      name: string;
      private: boolean;
    }>;
  };
  return data.repositories.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    name: r.name,
    private: r.private,
  }));
}

/**
 * Download a release tarball from GitHub using an installation token.
 * Per D-07: uses the auto-generated source tarball URL.
 * Per D-22: works for both public and private repos.
 *
 * Handles the redirect from api.github.com to codeload.github.com
 * by manually following 302 redirects (the redirect URL doesn't need auth).
 */
export async function downloadReleaseTarball(
  tarballUrl: string,
  installationToken: string,
): Promise<ArrayBuffer> {
  const headers = {
    Authorization: `Bearer ${installationToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let res = await fetch(tarballUrl, {
    headers,
    redirect: "manual",
  });

  // GitHub returns 302 redirect to codeload.github.com
  // The redirect URL doesn't need auth (it has a token in the URL)
  if (res.status === 302) {
    const location = res.headers.get("Location");
    if (!location) throw new Error("GitHub returned 302 without Location header");
    res = await fetch(location, {
      headers: { "User-Agent": USER_AGENT },
    });
  }

  if (!res.ok) {
    throw new Error(`Failed to download tarball: ${res.status}`);
  }

  return res.arrayBuffer();
}

/**
 * Verify that a GitHub App installation belongs to the authenticated user.
 * Per RESEARCH: the installation_id from the setup URL can be spoofed,
 * so we verify by checking the installation's account against the user.
 */
export async function verifyInstallation(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<{ accountLogin: string; accountId: number } | null> {
  const appJwt = await createAppJwt(appId, privateKeyPem);
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    account: { login: string; id: number };
  };
  return { accountLogin: data.account.login, accountId: data.account.id };
}
