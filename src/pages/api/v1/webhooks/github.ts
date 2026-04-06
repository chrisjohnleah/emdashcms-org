import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyWebhookSignature } from "../../../../lib/github/webhook-verify";
import { getLinkByRepoFullName } from "../../../../lib/github/queries";
import {
  getInstallationToken,
  downloadReleaseTarball,
} from "../../../../lib/github/installation";
import { validateBundle } from "../../../../lib/publishing/bundle-validator";
import { storeBundleInR2 } from "../../../../lib/publishing/r2-storage";
import {
  checkVersionExists,
  createVersion,
} from "../../../../lib/publishing/plugin-queries";
import { enqueueAuditJob } from "../../../../lib/publishing/queue";
import {
  checkAuthorAuditBudget,
  recordAuthorAuditUsage,
} from "../../../../lib/audit/author-budget";
import {
  extractVersion,
  hasPrereleaseSuffix,
  matchesTagPattern,
} from "../../../../lib/github/release-utils";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Step 1: Read raw body BEFORE JSON parsing (critical for HMAC verification)
  const rawBody = await request.text();

  // Step 2: Verify HMAC-SHA256 signature (D-12)
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const valid = await verifyWebhookSignature(
    rawBody,
    signature,
    env.GITHUB_WEBHOOK_SECRET,
  );
  if (!valid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Step 3: Parse payload -- only process release events
  const event = request.headers.get("X-GitHub-Event");
  if (event !== "release") {
    return new Response(JSON.stringify({ message: "Event ignored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: {
    action: string;
    release: {
      tag_name: string;
      prerelease: boolean;
      draft: boolean;
      tarball_url: string;
      body: string | null;
    };
    repository: { full_name: string };
    installation?: { id: number };
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Step 4: Filter -- only "published" action for stable releases (D-06, D-08)
  if (payload.action !== "published") {
    return new Response(JSON.stringify({ message: "Action ignored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (payload.release.draft) {
    return new Response(JSON.stringify({ message: "Draft release ignored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (
    payload.release.prerelease ||
    hasPrereleaseSuffix(payload.release.tag_name)
  ) {
    return new Response(
      JSON.stringify({ message: "Pre-release ignored" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (!payload.installation?.id) {
    return new Response(
      JSON.stringify({ error: "No installation context" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Step 5: Look up plugin-repo link by repo full_name
  const link = await getLinkByRepoFullName(
    env.DB,
    payload.repository.full_name,
  );
  if (!link) {
    return new Response(JSON.stringify({ message: "Repo not linked" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Step 6: Check auto_submit is enabled (D-09)
  if (!link.autoSubmit) {
    return new Response(
      JSON.stringify({ message: "Auto-submit disabled" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Step 6b: Check tag matches publisher-configured pattern (GHAP-04)
  if (!matchesTagPattern(payload.release.tag_name, link.tagPattern)) {
    return new Response(
      JSON.stringify({ message: "Tag does not match pattern" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Step 7: Extract and validate version from tag (D-11)
  const version = extractVersion(payload.release.tag_name);
  if (!version) {
    console.warn(
      `[webhook] Empty version from tag: ${payload.release.tag_name}`,
    );
    return new Response(JSON.stringify({ error: "Empty version" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Step 8: Check for duplicate (Pitfall 6: at-least-once delivery)
  const exists = await checkVersionExists(env.DB, link.pluginId, version);
  if (exists) {
    return new Response(
      JSON.stringify({ message: "Version already exists" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Step 9: Get installation token (D-19: fresh token each time)
    const installationToken = await getInstallationToken(
      payload.installation.id,
      env.GITHUB_CLIENT_ID,
      env.GITHUB_APP_PRIVATE_KEY,
    );

    // Step 10: Download tarball (D-07: auto-generated source tarball)
    const tarballBytes = await downloadReleaseTarball(
      payload.release.tarball_url,
      installationToken,
    );

    // Step 11: Validate bundle through existing pipeline (D-13)
    const validation = await validateBundle(tarballBytes, link.pluginId);
    if (!validation.valid) {
      console.warn(
        `[webhook] Validation failed for ${link.pluginId}@${version}: ${validation.errors?.join("; ")}`,
      );
      return new Response(
        JSON.stringify({
          message: "Validation failed",
          errors: validation.errors,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Step 12: Verify version from tag matches manifest version (D-11)
    if (validation.manifest!.version !== version) {
      console.warn(
        `[webhook] Version mismatch: tag=${version}, manifest=${validation.manifest!.version}`,
      );
      return new Response(
        JSON.stringify({
          message: "Version mismatch",
          tag: version,
          manifest: validation.manifest!.version,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Audit budget check (COST-03) — runs BEFORE we write to R2 or D1
    // so we don't leave orphaned objects/rows when the budget is exhausted.
    const budget = await checkAuthorAuditBudget(env.DB, link.authorId);
    if (!budget.allowed) {
      console.log(`[webhook] Author ${link.authorId} audit budget exceeded, skipping`);
      return new Response(
        JSON.stringify({ message: "Author audit budget exceeded" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 13: Store in R2
    const { key: bundleKey } = await storeBundleInR2(
      env.ARTIFACTS,
      link.pluginId,
      version,
      tarballBytes,
      validation.checksum!,
    );

    // Step 14: Create version record with source='github' (D-16)
    const versionId = await createVersion(env.DB, {
      pluginId: link.pluginId,
      version,
      manifest: JSON.stringify(validation.manifest),
      bundleKey,
      checksum: validation.checksum!,
      fileCount: validation.stats!.fileCount,
      compressedSize: validation.stats!.compressedSize,
      decompressedSize: validation.stats!.decompressedSize,
      changelog: payload.release.body ?? undefined,
      minEmDashVersion: validation.manifest!.minEmDashVersion ?? undefined,
      source: "github",
    });

    await enqueueAuditJob(env.AUDIT_QUEUE, {
      pluginId: link.pluginId,
      version,
      authorId: link.authorId,
      bundleKey,
    });
    await recordAuthorAuditUsage(env.DB, link.authorId);

    console.log(
      `[webhook] Queued audit for ${link.pluginId}@${version} (id=${versionId})`,
    );
    return new Response(
      JSON.stringify({
        message: "Version queued",
        version,
        pluginId: link.pluginId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(
      `[webhook] Error processing release for ${link.pluginId}:`,
      err,
    );
    // Return 200 to prevent GitHub from retrying on permanent errors
    // Per D-10: silent failure
    return new Response(
      JSON.stringify({ message: "Processing error" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
