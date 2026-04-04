import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getCallbackUrl } from "../../../../lib/auth/github";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect }) => {
  const state = crypto.randomUUID();

  cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: getCallbackUrl(),
    state,
    scope: "read:user",
  });

  return redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
};
