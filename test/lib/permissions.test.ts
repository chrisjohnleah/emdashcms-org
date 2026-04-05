import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  checkPluginAccess,
  hasRole,
  ROLE_HIERARCHY,
} from "../../src/lib/auth/permissions";

// ---------------------------------------------------------------------------
// Seed data: authors, plugins, themes, and collaborator records
// ---------------------------------------------------------------------------

const OWNER_ID = "perm-test-owner";
const MAINTAINER_ID = "perm-test-maintainer";
const CONTRIBUTOR_ID = "perm-test-contributor";
const STRANGER_ID = "perm-test-stranger";
const PLUGIN_ID = "perm-test-plugin";
const THEME_ID = "perm-test-theme";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 900001, "perm-owner"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(MAINTAINER_ID, 900002, "perm-maintainer"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(CONTRIBUTOR_ID, 900003, "perm-contributor"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(STRANGER_ID, 900004, "perm-stranger"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, "Perm Test Plugin", "For permission tests"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, OWNER_ID, "Perm Test Theme", "For permission tests"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("collab-maint-1", PLUGIN_ID, MAINTAINER_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("collab-contrib-1", PLUGIN_ID, CONTRIBUTOR_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("collab-maint-theme-1", THEME_ID, MAINTAINER_ID),
  ]);
});

// ---------------------------------------------------------------------------
// checkPluginAccess
// ---------------------------------------------------------------------------

describe("checkPluginAccess", () => {
  it("returns { found: true, role: 'owner' } for plugin owner", async () => {
    const result = await checkPluginAccess(env.DB, OWNER_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: "owner" });
  });

  it("returns { found: true, role: 'maintainer' } for maintainer collaborator", async () => {
    const result = await checkPluginAccess(env.DB, MAINTAINER_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: "maintainer" });
  });

  it("returns { found: true, role: 'contributor' } for contributor collaborator", async () => {
    const result = await checkPluginAccess(env.DB, CONTRIBUTOR_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: "contributor" });
  });

  it("returns { found: true, role: null } for unknown user on existing plugin", async () => {
    const result = await checkPluginAccess(env.DB, STRANGER_ID, PLUGIN_ID);
    expect(result).toEqual({ found: true, role: null });
  });

  it("returns { found: false } for nonexistent plugin", async () => {
    const result = await checkPluginAccess(env.DB, OWNER_ID, "nonexistent-id");
    expect(result).toEqual({ found: false });
  });

  it("returns { found: true, role: 'owner' } for theme owner", async () => {
    const result = await checkPluginAccess(env.DB, OWNER_ID, THEME_ID);
    expect(result).toEqual({ found: true, role: "owner" });
  });

  it("returns { found: true, role: 'maintainer' } for theme maintainer", async () => {
    const result = await checkPluginAccess(env.DB, MAINTAINER_ID, THEME_ID);
    expect(result).toEqual({ found: true, role: "maintainer" });
  });
});

// ---------------------------------------------------------------------------
// hasRole
// ---------------------------------------------------------------------------

describe("hasRole", () => {
  it("owner has owner role", () => {
    expect(hasRole("owner", "owner")).toBe(true);
  });

  it("owner has maintainer role", () => {
    expect(hasRole("owner", "maintainer")).toBe(true);
  });

  it("owner has contributor role", () => {
    expect(hasRole("owner", "contributor")).toBe(true);
  });

  it("maintainer has maintainer role", () => {
    expect(hasRole("maintainer", "maintainer")).toBe(true);
  });

  it("maintainer has contributor role", () => {
    expect(hasRole("maintainer", "contributor")).toBe(true);
  });

  it("maintainer does NOT have owner role", () => {
    expect(hasRole("maintainer", "owner")).toBe(false);
  });

  it("contributor has contributor role", () => {
    expect(hasRole("contributor", "contributor")).toBe(true);
  });

  it("contributor does NOT have maintainer role", () => {
    expect(hasRole("contributor", "maintainer")).toBe(false);
  });

  it("contributor does NOT have owner role", () => {
    expect(hasRole("contributor", "owner")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ROLE_HIERARCHY
// ---------------------------------------------------------------------------

describe("ROLE_HIERARCHY", () => {
  it("exports hierarchy with owner > maintainer > contributor", () => {
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.maintainer);
    expect(ROLE_HIERARCHY.maintainer).toBeGreaterThan(ROLE_HIERARCHY.contributor);
  });
});
