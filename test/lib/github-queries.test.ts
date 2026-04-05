import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  saveInstallation,
  getInstallation,
  getInstallationByAuthor,
  linkPluginToRepo,
  getPluginGitHubLink,
  getLinkByRepoFullName,
  toggleAutoSubmit,
  unlinkPlugin,
  setTagPattern,
} from "../../src/lib/github/queries";

// ---------------------------------------------------------------------------
// Seed data: author and plugin records for FK constraints
// ---------------------------------------------------------------------------

const AUTHOR_ID = "test-author-uuid-gh-queries";
const AUTHOR_ID_2 = "test-author-uuid-gh-queries-2";
const PLUGIN_ID = "test-gh-plugin";
const PLUGIN_ID_2 = "test-gh-plugin-2";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(AUTHOR_ID, 100001, "test-user-gh"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(AUTHOR_ID_2, 100002, "test-user-gh-2"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, AUTHOR_ID, "Test GH Plugin", "A test plugin for GH queries"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID_2, AUTHOR_ID, "Test GH Plugin 2", "Another test plugin"),
  ]);
});

// ---------------------------------------------------------------------------
// Installations
// ---------------------------------------------------------------------------

describe("github_installations CRUD", () => {
  it("saveInstallation inserts a record and getInstallation retrieves it", async () => {
    await saveInstallation(env.DB, {
      id: 50001,
      accountLogin: "test-org",
      accountId: 200001,
      authorId: AUTHOR_ID,
    });

    const result = await getInstallation(env.DB, 50001);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(50001);
    expect(result!.accountLogin).toBe("test-org");
    expect(result!.accountId).toBe(200001);
    expect(result!.authorId).toBe(AUTHOR_ID);
  });

  it("saveInstallation with same ID updates (INSERT OR REPLACE)", async () => {
    await saveInstallation(env.DB, {
      id: 50001,
      accountLogin: "updated-org",
      accountId: 200001,
      authorId: AUTHOR_ID,
    });

    const result = await getInstallation(env.DB, 50001);
    expect(result!.accountLogin).toBe("updated-org");
  });

  it("getInstallation returns null for non-existent ID", async () => {
    const result = await getInstallation(env.DB, 99999);
    expect(result).toBeNull();
  });

  it("getInstallationByAuthor returns installation for a given author_id", async () => {
    const result = await getInstallationByAuthor(env.DB, AUTHOR_ID);
    expect(result).not.toBeNull();
    expect(result!.authorId).toBe(AUTHOR_ID);
    expect(result!.id).toBe(50001);
  });

  it("getInstallationByAuthor returns null for author with no installation", async () => {
    const result = await getInstallationByAuthor(env.DB, AUTHOR_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plugin-repo links
// ---------------------------------------------------------------------------

describe("plugin_github_links CRUD", () => {
  it("linkPluginToRepo inserts and getPluginGitHubLink retrieves with autoSubmit true", async () => {
    const linkId = await linkPluginToRepo(env.DB, {
      pluginId: PLUGIN_ID,
      installationId: 50001,
      repoFullName: "test-org/test-repo",
      repoId: 300001,
    });

    expect(typeof linkId).toBe("string");
    expect(linkId.length).toBeGreaterThan(0);

    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link).not.toBeNull();
    expect(link!.pluginId).toBe(PLUGIN_ID);
    expect(link!.installationId).toBe(50001);
    expect(link!.repoFullName).toBe("test-org/test-repo");
    expect(link!.repoId).toBe(300001);
    expect(link!.autoSubmit).toBe(true);
  });

  it("getLinkByRepoFullName returns the link with authorId from joined query", async () => {
    const result = await getLinkByRepoFullName(env.DB, "test-org/test-repo");
    expect(result).not.toBeNull();
    expect(result!.pluginId).toBe(PLUGIN_ID);
    expect(result!.authorId).toBe(AUTHOR_ID);
    expect(result!.repoFullName).toBe("test-org/test-repo");
  });

  it("getLinkByRepoFullName returns null for unknown repo", async () => {
    const result = await getLinkByRepoFullName(env.DB, "unknown/repo");
    expect(result).toBeNull();
  });

  it("toggleAutoSubmit sets auto_submit to false", async () => {
    await toggleAutoSubmit(env.DB, PLUGIN_ID, false);
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link!.autoSubmit).toBe(false);
  });

  it("toggleAutoSubmit sets auto_submit back to true", async () => {
    await toggleAutoSubmit(env.DB, PLUGIN_ID, true);
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link!.autoSubmit).toBe(true);
  });

  it("unlinkPlugin deletes the link", async () => {
    await unlinkPlugin(env.DB, PLUGIN_ID);
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link).toBeNull();
  });

  it("getPluginGitHubLink returns tagPattern defaulting to '*'", async () => {
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link).not.toBeNull();
    expect(link!.tagPattern).toBe("*");
  });

  it("setTagPattern updates the tag_pattern for a plugin", async () => {
    await setTagPattern(env.DB, PLUGIN_ID, "v*");
    const link = await getPluginGitHubLink(env.DB, PLUGIN_ID);
    expect(link).not.toBeNull();
    expect(link!.tagPattern).toBe("v*");
    // Reset back to default
    await setTagPattern(env.DB, PLUGIN_ID, "*");
  });

  it("getLinkByRepoFullName returns tagPattern", async () => {
    const link = await getLinkByRepoFullName(env.DB, "test-org/test-repo");
    expect(link).not.toBeNull();
    expect(link!.tagPattern).toBe("*");
  });

  it("duplicate linkPluginToRepo for same plugin throws UNIQUE constraint error", async () => {
    // Re-link the first plugin
    await linkPluginToRepo(env.DB, {
      pluginId: PLUGIN_ID_2,
      installationId: 50001,
      repoFullName: "test-org/repo-a",
      repoId: 300002,
    });

    // Try to link the same plugin again (UNIQUE on plugin_id)
    await expect(
      linkPluginToRepo(env.DB, {
        pluginId: PLUGIN_ID_2,
        installationId: 50001,
        repoFullName: "test-org/repo-b",
        repoId: 300003,
      }),
    ).rejects.toThrow();
  });
});
