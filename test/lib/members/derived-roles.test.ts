import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { isAuthor } from "../../../src/lib/members/derived-roles";

// ---------------------------------------------------------------------------
// Seed data — IDs prefixed `derived-` to avoid collision with rbac.test.ts
// ---------------------------------------------------------------------------

const PLUGIN_OWNER_ID = "derived-plugin-owner";
const THEME_OWNER_ID = "derived-theme-owner";
const COLLAB_OWNER_ID = "derived-collab-plugin-owner";
const COLLABORATOR_ID = "derived-collaborator";
const NO_CONTENT_ID = "derived-no-content";
const PLUGIN_ID = "derived-plugin";
const THEME_ID = "derived-theme";
const COLLAB_PLUGIN_ID = "derived-collab-plugin";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(PLUGIN_OWNER_ID, 900001, "derived-plugin-owner"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(THEME_OWNER_ID, 900002, "derived-theme-owner"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(COLLAB_OWNER_ID, 900003, "derived-collab-plugin-owner"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(COLLABORATOR_ID, 900004, "derived-collaborator"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(NO_CONTENT_ID, 900005, "derived-no-content"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, PLUGIN_OWNER_ID, "Derived Test Plugin", "isAuthor unit test"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(
      COLLAB_PLUGIN_ID,
      COLLAB_OWNER_ID,
      "Derived Collab Plugin",
      "isAuthor unit test",
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, THEME_OWNER_ID, "Derived Test Theme", "isAuthor unit test"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("derived-collab-link", COLLAB_PLUGIN_ID, COLLABORATOR_ID),
  ]);
});

describe("isAuthor — UNION query over plugins/themes/plugin_collaborators", () => {
  it("returns true for a plugin owner", async () => {
    expect(await isAuthor(env.DB, PLUGIN_OWNER_ID)).toBe(true);
  });

  it("returns true for a theme owner", async () => {
    expect(await isAuthor(env.DB, THEME_OWNER_ID)).toBe(true);
  });

  it("returns true for a plugin collaborator", async () => {
    expect(await isAuthor(env.DB, COLLABORATOR_ID)).toBe(true);
  });

  it("returns false for an authenticated member with no content", async () => {
    expect(await isAuthor(env.DB, NO_CONTENT_ID)).toBe(false);
  });

  it("returns false for an unknown member id", async () => {
    expect(await isAuthor(env.DB, "derived-unknown-member-id")).toBe(false);
  });
});
