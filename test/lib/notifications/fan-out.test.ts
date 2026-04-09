import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { resolveRecipients } from "../../../src/lib/notifications/fan-out";

// ---------------------------------------------------------------------------
// Seed: owner + maintainer + contributor on both a plugin and a theme.
// ---------------------------------------------------------------------------

const OWNER_ID = "fo-owner";
const MAINTAINER_ID = "fo-maint";
const CONTRIBUTOR_ID = "fo-contrib";
const PLUGIN_ID = "fo-plugin";
const THEME_ID = "fo-theme";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 810001, "fo-owner-user"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(MAINTAINER_ID, 810002, "fo-maintainer-user"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(CONTRIBUTOR_ID, 810003, "fo-contributor-user"),

    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, "Fan-out Plugin", "Fan-out test plugin"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, OWNER_ID, "Fan-out Theme", "Fan-out test theme"),

    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("fo-collab-maint-plugin", PLUGIN_ID, MAINTAINER_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("fo-collab-contrib-plugin", PLUGIN_ID, CONTRIBUTOR_ID),

    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("fo-collab-maint-theme", THEME_ID, MAINTAINER_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("fo-collab-contrib-theme", THEME_ID, CONTRIBUTOR_ID),
  ]);
});

// ---------------------------------------------------------------------------
// resolveRecipients
// ---------------------------------------------------------------------------

describe("resolveRecipients — plugin", () => {
  it("returns owner + maintainer, excluding contributor", async () => {
    const recipients = await resolveRecipients(env.DB, "plugin", PLUGIN_ID);
    expect(recipients).toHaveLength(2);

    const ids = recipients.map((r) => r.authorId).sort();
    expect(ids).toEqual([MAINTAINER_ID, OWNER_ID].sort());
    expect(ids).not.toContain(CONTRIBUTOR_ID);
  });

  it("labels owner with role='owner' and maintainer with role='maintainer'", async () => {
    const recipients = await resolveRecipients(env.DB, "plugin", PLUGIN_ID);
    const owner = recipients.find((r) => r.authorId === OWNER_ID);
    const maintainer = recipients.find(
      (r) => r.authorId === MAINTAINER_ID,
    );
    expect(owner?.role).toBe("owner");
    expect(maintainer?.role).toBe("maintainer");
  });

  it("populates githubUsername for each recipient", async () => {
    const recipients = await resolveRecipients(env.DB, "plugin", PLUGIN_ID);
    const owner = recipients.find((r) => r.authorId === OWNER_ID);
    const maintainer = recipients.find(
      (r) => r.authorId === MAINTAINER_ID,
    );
    expect(owner?.githubUsername).toBe("fo-owner-user");
    expect(maintainer?.githubUsername).toBe("fo-maintainer-user");
  });
});

describe("resolveRecipients — theme", () => {
  it("returns owner + maintainer, excluding contributor for themes", async () => {
    const recipients = await resolveRecipients(env.DB, "theme", THEME_ID);
    expect(recipients).toHaveLength(2);
    const ids = recipients.map((r) => r.authorId);
    expect(ids).toContain(OWNER_ID);
    expect(ids).toContain(MAINTAINER_ID);
    expect(ids).not.toContain(CONTRIBUTOR_ID);
  });
});

describe("resolveRecipients — empty", () => {
  it("returns [] (not throws) for an unknown entity id", async () => {
    const recipients = await resolveRecipients(
      env.DB,
      "plugin",
      "nonexistent-id",
    );
    expect(recipients).toEqual([]);
  });
});
