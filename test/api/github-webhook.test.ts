import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { verifyWebhookSignature } from "../../src/lib/github/webhook-verify";
import {
  saveInstallation,
  linkPluginToRepo,
  getLinkByRepoFullName,
  toggleAutoSubmit,
  getPluginGitHubLink,
} from "../../src/lib/github/queries";
import {
  checkVersionExists,
  createVersion,
} from "../../src/lib/publishing/plugin-queries";
import {
  extractVersion,
  hasPrereleaseSuffix,
} from "../../src/lib/github/release-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedAuthor(
  db: D1Database,
  id: string,
  githubId: number,
  username: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, '2026-04-05T10:00:00Z', '2026-04-05T10:00:00Z')`,
    )
    .bind(id, githubId, username, `https://avatars.githubusercontent.com/u/${githubId}`)
    .run();
}

async function seedPlugin(
  db: D1Database,
  pluginId: string,
  authorId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'content', '["content:read"]', '["test"]', 0, '2026-04-05T10:00:00Z', '2026-04-05T10:00:00Z')`,
    )
    .bind(pluginId, authorId, `Test Plugin ${pluginId}`, `Description for ${pluginId}`)
    .run();
}

/**
 * Compute a valid HMAC-SHA256 signature for a payload, matching GitHub's format.
 */
async function computeSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-webhook-secret-at-least-32-characters";
const AUTHOR_ID = "wh-author-1";
const PLUGIN_ID = "webhook-test-plugin";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_github_links"),
    env.DB.prepare("DELETE FROM github_installations"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await seedAuthor(env.DB, AUTHOR_ID, 9001, "webhook-publisher");
  await seedPlugin(env.DB, PLUGIN_ID, AUTHOR_ID);

  await saveInstallation(env.DB, {
    id: 5001,
    accountLogin: "webhook-publisher",
    accountId: 9001,
    authorId: AUTHOR_ID,
  });

  await linkPluginToRepo(env.DB, {
    pluginId: PLUGIN_ID,
    installationId: 5001,
    repoFullName: "webhook-publisher/my-plugin",
    repoId: 70001,
  });
});

// ---------------------------------------------------------------------------
// Release filtering logic (extractVersion, hasPrereleaseSuffix)
// ---------------------------------------------------------------------------

describe("Release tag filtering", () => {
  it("extractVersion strips 'v' prefix", () => {
    expect(extractVersion("v1.2.3")).toBe("1.2.3");
  });

  it("extractVersion returns tag unchanged when no 'v' prefix", () => {
    expect(extractVersion("1.2.3")).toBe("1.2.3");
  });

  it("hasPrereleaseSuffix detects -beta", () => {
    expect(hasPrereleaseSuffix("v1.0.0-beta.1")).toBe(true);
  });

  it("hasPrereleaseSuffix detects -rc", () => {
    expect(hasPrereleaseSuffix("v2.0.0-rc.1")).toBe(true);
  });

  it("hasPrereleaseSuffix detects -dev", () => {
    expect(hasPrereleaseSuffix("v1.0.0-dev")).toBe(true);
  });

  it("hasPrereleaseSuffix detects -alpha", () => {
    expect(hasPrereleaseSuffix("v1.0.0-alpha.3")).toBe(true);
  });

  it("hasPrereleaseSuffix detects -canary", () => {
    expect(hasPrereleaseSuffix("v1.0.0-canary.20260405")).toBe(true);
  });

  it("hasPrereleaseSuffix detects -next", () => {
    expect(hasPrereleaseSuffix("v3.0.0-next.1")).toBe(true);
  });

  it("hasPrereleaseSuffix returns false for stable tags", () => {
    expect(hasPrereleaseSuffix("v1.0.0")).toBe(false);
    expect(hasPrereleaseSuffix("2.3.4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

describe("Webhook HMAC-SHA256 verification", () => {
  const samplePayload = JSON.stringify({
    action: "published",
    release: { tag_name: "v1.0.0" },
  });

  it("accepts a valid HMAC signature", async () => {
    const sig = await computeSignature(samplePayload, WEBHOOK_SECRET);
    const result = await verifyWebhookSignature(
      samplePayload,
      sig,
      WEBHOOK_SECRET,
    );
    expect(result).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const sig = await computeSignature(samplePayload, WEBHOOK_SECRET);
    const tampered = samplePayload.replace("published", "edited");
    const result = await verifyWebhookSignature(tampered, sig, WEBHOOK_SECRET);
    expect(result).toBe(false);
  });

  it("rejects an incorrect secret", async () => {
    const sig = await computeSignature(samplePayload, "wrong-secret-value");
    const result = await verifyWebhookSignature(
      samplePayload,
      sig,
      WEBHOOK_SECRET,
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D1 pipeline integration (link lookup, version creation, duplicates)
// ---------------------------------------------------------------------------

describe("Webhook D1 pipeline integration", () => {
  it("getLinkByRepoFullName returns link with authorId", async () => {
    const link = await getLinkByRepoFullName(
      env.DB,
      "webhook-publisher/my-plugin",
    );
    expect(link).not.toBeNull();
    expect(link!.pluginId).toBe(PLUGIN_ID);
    expect(link!.installationId).toBe(5001);
    expect(link!.repoFullName).toBe("webhook-publisher/my-plugin");
    expect(link!.autoSubmit).toBe(true);
    expect(link!.authorId).toBe(AUTHOR_ID);
  });

  it("getLinkByRepoFullName returns null for unlinked repo", async () => {
    const link = await getLinkByRepoFullName(env.DB, "unknown/repo");
    expect(link).toBeNull();
  });

  it("checkVersionExists returns false for new version", async () => {
    const exists = await checkVersionExists(env.DB, PLUGIN_ID, "1.0.0");
    expect(exists).toBe(false);
  });

  it("createVersion with source='github' returns UUID", async () => {
    const versionId = await createVersion(env.DB, {
      pluginId: PLUGIN_ID,
      version: "1.0.0",
      manifest: '{"id":"webhook-test-plugin","version":"1.0.0"}',
      bundleKey: "plugins/webhook-test-plugin/1.0.0/bundle.tgz",
      checksum: "abc123",
      fileCount: 3,
      compressedSize: 2048,
      decompressedSize: 8192,
      changelog: "Initial release from GitHub",
      source: "github",
    });
    expect(versionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("checkVersionExists returns true after creation (duplicate protection)", async () => {
    const exists = await checkVersionExists(env.DB, PLUGIN_ID, "1.0.0");
    expect(exists).toBe(true);
  });

  it("version record has source='github'", async () => {
    const row = await env.DB
      .prepare(
        "SELECT source FROM plugin_versions WHERE plugin_id = ? AND version = ?",
      )
      .bind(PLUGIN_ID, "1.0.0")
      .first<{ source: string }>();
    expect(row).not.toBeNull();
    expect(row!.source).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// Auto-submit toggle
// ---------------------------------------------------------------------------

describe("Auto-submit toggle", () => {
  it("disabling auto-submit updates the link", async () => {
    await toggleAutoSubmit(env.DB, PLUGIN_ID, false);
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link).not.toBeNull();
    expect(link!.autoSubmit).toBe(false);
  });

  it("re-enabling auto-submit updates the link", async () => {
    await toggleAutoSubmit(env.DB, PLUGIN_ID, true);
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link).not.toBeNull();
    expect(link!.autoSubmit).toBe(true);
  });
});
