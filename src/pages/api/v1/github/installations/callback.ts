import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyInstallation } from "../../../../../lib/github/installation";
import { saveInstallation } from "../../../../../lib/github/queries";
import { resolveAuthorId } from "../../../../../lib/publishing/plugin-queries";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals, redirect }) => {
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  // GitHub sends setup_action=install on new install, setup_action=update on permission changes
  if (!installationId || (setupAction !== "install" && setupAction !== "update")) {
    return redirect("/dashboard?banner=GitHub+App+installation+failed.+Please+try+again.&bannerType=error");
  }

  const author = locals.author;
  if (!author) {
    return redirect("/api/v1/auth/github");
  }

  const authorId = await resolveAuthorId(env.DB, author.githubId);
  if (!authorId) {
    return redirect("/dashboard?banner=Author+not+found.&bannerType=error");
  }

  try {
    const installInfo = await verifyInstallation(
      Number(installationId),
      env.GITHUB_CLIENT_ID,
      env.GITHUB_APP_PRIVATE_KEY,
    );

    if (!installInfo) {
      return redirect("/dashboard?banner=GitHub+App+installation+failed.+Please+try+again.&bannerType=error");
    }

    // Verify the installation belongs to the authenticated user. Without this
    // check, a logged-in attacker could intercept the callback URL and claim
    // someone else's GitHub App installation under their own account.
    if (installInfo.accountId !== author.githubId) {
      console.warn(
        `[github] Installation ownership mismatch: install_id=${installationId} install_account=${installInfo.accountId} session_account=${author.githubId}`,
      );
      return redirect("/dashboard?banner=GitHub+App+installation+does+not+belong+to+your+account.&bannerType=error");
    }

    await saveInstallation(env.DB, {
      id: Number(installationId),
      accountLogin: installInfo.accountLogin,
      accountId: installInfo.accountId,
      authorId,
    });

    return redirect("/dashboard?banner=GitHub+App+installed.+Connect+it+to+a+plugin+from+the+plugin+detail+page.&bannerType=success");
  } catch (err) {
    console.error("[github] Installation callback error:", err);
    return redirect("/dashboard?banner=GitHub+App+installation+failed.+Please+try+again.&bannerType=error");
  }
};
