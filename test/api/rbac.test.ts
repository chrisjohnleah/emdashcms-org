import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  checkPluginAccess,
  hasRole,
  type Role,
} from "../../src/lib/auth/permissions";

// ---------------------------------------------------------------------------
// Seed data: authors, plugins, themes, and collaborator records
// ---------------------------------------------------------------------------

const OWNER_ID = "rbac-test-owner";
const MAINTAINER_ID = "rbac-test-maintainer";
const CONTRIBUTOR_ID = "rbac-test-contributor";
const STRANGER_ID = "rbac-test-stranger";
const PLUGIN_ID = "rbac-test-plugin";
const THEME_ID = "rbac-test-theme";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 800001, "rbac-owner"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(MAINTAINER_ID, 800002, "rbac-maintainer"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(CONTRIBUTOR_ID, 800003, "rbac-contributor"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(STRANGER_ID, 800004, "rbac-stranger"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, "RBAC Test Plugin", "RBAC integration test"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, OWNER_ID, "RBAC Test Theme", "RBAC integration test"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("rbac-collab-maint-plugin", PLUGIN_ID, MAINTAINER_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("rbac-collab-contrib-plugin", PLUGIN_ID, CONTRIBUTOR_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("rbac-collab-maint-theme", THEME_ID, MAINTAINER_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("rbac-collab-contrib-theme", THEME_ID, CONTRIBUTOR_ID),
  ]);
});

// ---------------------------------------------------------------------------
// checkPluginAccess — plugin entity
// ---------------------------------------------------------------------------

describe("RBAC enforcement: checkPluginAccess on plugins", () => {
  it("returns owner role for plugin owner", async () => {
    const result = await checkPluginAccess(env.DB, OWNER_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: "owner" });
  });

  it("returns maintainer role for maintainer collaborator", async () => {
    const result = await checkPluginAccess(env.DB, MAINTAINER_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: "maintainer" });
  });

  it("returns contributor role for contributor collaborator", async () => {
    const result = await checkPluginAccess(env.DB, CONTRIBUTOR_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: "contributor" });
  });

  it("returns null role for unrelated author", async () => {
    const result = await checkPluginAccess(env.DB, STRANGER_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: null });
  });

  it("returns not found for nonexistent plugin", async () => {
    const result = await checkPluginAccess(env.DB, OWNER_ID, "nonexistent-plugin");
    expect(result).toEqual({ found: false });
  });
});

// ---------------------------------------------------------------------------
// checkPluginAccess — theme entity
// ---------------------------------------------------------------------------

describe("RBAC enforcement: checkPluginAccess on themes", () => {
  it("returns owner role for theme owner", async () => {
    const result = await checkPluginAccess(env.DB, OWNER_ID, THEME_ID);
    expect(result).toEqual({ found: true, role: "owner" });
  });

  it("returns maintainer role for theme maintainer", async () => {
    const result = await checkPluginAccess(env.DB, MAINTAINER_ID, THEME_ID);
    expect(result).toEqual({ found: true, role: "maintainer" });
  });

  it("returns contributor role for theme contributor", async () => {
    const result = await checkPluginAccess(env.DB, CONTRIBUTOR_ID, THEME_ID);
    expect(result).toEqual({ found: true, role: "contributor" });
  });

  it("returns null role for unrelated author on theme", async () => {
    const result = await checkPluginAccess(env.DB, STRANGER_ID, THEME_ID);
    expect(result).toEqual({ found: true, role: null });
  });
});

// ---------------------------------------------------------------------------
// hasRole — permission hierarchy enforcement
// ---------------------------------------------------------------------------

describe("RBAC enforcement: hasRole hierarchy", () => {
  it("owner meets owner requirement", () => {
    expect(hasRole("owner", "owner")).toBe(true);
  });

  it("owner meets maintainer requirement", () => {
    expect(hasRole("owner", "maintainer")).toBe(true);
  });

  it("owner meets contributor requirement", () => {
    expect(hasRole("owner", "contributor")).toBe(true);
  });

  it("maintainer meets maintainer requirement", () => {
    expect(hasRole("maintainer", "maintainer")).toBe(true);
  });

  it("maintainer meets contributor requirement", () => {
    expect(hasRole("maintainer", "contributor")).toBe(true);
  });

  it("maintainer does NOT meet owner requirement", () => {
    expect(hasRole("maintainer", "owner")).toBe(false);
  });

  it("contributor meets contributor requirement", () => {
    expect(hasRole("contributor", "contributor")).toBe(true);
  });

  it("contributor does NOT meet maintainer requirement", () => {
    expect(hasRole("contributor", "maintainer")).toBe(false);
  });

  it("contributor does NOT meet owner requirement", () => {
    expect(hasRole("contributor", "owner")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RBAC decision matrix: simulated endpoint enforcement
// ---------------------------------------------------------------------------

describe("RBAC enforcement: endpoint access simulation", () => {
  /**
   * Simulate the exact pattern used in all write endpoints:
   *   const access = await checkPluginAccess(db, authorId, pluginId);
   *   if (!access.found) return 404;
   *   if (!access.role || !hasRole(access.role, requiredRole)) return 403;
   */
  async function canAccess(
    authorId: string,
    entityId: string,
    requiredRole: Role,
  ): Promise<"allowed" | 403 | 404> {
    const access = await checkPluginAccess(env.DB, authorId, entityId);
    if (!access.found) return 404;
    if (!access.role || !hasRole(access.role, requiredRole)) return 403;
    return "allowed";
  }

  // Upload / edit / retry (maintainer+ required)
  it("owner can upload versions (maintainer+ endpoint)", async () => {
    expect(await canAccess(OWNER_ID, PLUGIN_ID, "maintainer")).toBe("allowed");
  });

  it("maintainer can upload versions (maintainer+ endpoint)", async () => {
    expect(await canAccess(MAINTAINER_ID, PLUGIN_ID, "maintainer")).toBe("allowed");
  });

  it("contributor CANNOT upload versions (maintainer+ endpoint)", async () => {
    expect(await canAccess(CONTRIBUTOR_ID, PLUGIN_ID, "maintainer")).toBe(403);
  });

  it("stranger CANNOT upload versions (maintainer+ endpoint)", async () => {
    expect(await canAccess(STRANGER_ID, PLUGIN_ID, "maintainer")).toBe(403);
  });

  it("nonexistent entity returns 404", async () => {
    expect(await canAccess(OWNER_ID, "no-such-plugin", "maintainer")).toBe(404);
  });

  // Owner-only actions (disconnect, delete, transfer)
  it("owner can perform owner-only actions", async () => {
    expect(await canAccess(OWNER_ID, PLUGIN_ID, "owner")).toBe("allowed");
  });

  it("maintainer CANNOT perform owner-only actions", async () => {
    expect(await canAccess(MAINTAINER_ID, PLUGIN_ID, "owner")).toBe(403);
  });

  it("contributor CANNOT perform owner-only actions", async () => {
    expect(await canAccess(CONTRIBUTOR_ID, PLUGIN_ID, "owner")).toBe(403);
  });

  // Contributor view (contributor+ required)
  it("contributor can view (contributor+ endpoint)", async () => {
    expect(await canAccess(CONTRIBUTOR_ID, PLUGIN_ID, "contributor")).toBe("allowed");
  });

  it("stranger CANNOT view (contributor+ endpoint)", async () => {
    expect(await canAccess(STRANGER_ID, PLUGIN_ID, "contributor")).toBe(403);
  });

  // Theme endpoints follow the same pattern
  it("maintainer can edit theme (maintainer+ endpoint)", async () => {
    expect(await canAccess(MAINTAINER_ID, THEME_ID, "maintainer")).toBe("allowed");
  });

  it("contributor CANNOT edit theme (maintainer+ endpoint)", async () => {
    expect(await canAccess(CONTRIBUTOR_ID, THEME_ID, "maintainer")).toBe(403);
  });

  it("only owner can disconnect theme GitHub (owner-only)", async () => {
    expect(await canAccess(OWNER_ID, THEME_ID, "owner")).toBe("allowed");
    expect(await canAccess(MAINTAINER_ID, THEME_ID, "owner")).toBe(403);
  });
});
