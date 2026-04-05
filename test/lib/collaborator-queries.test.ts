import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  createInvite,
  getPendingInvitesForUser,
  acceptInvite,
  declineInvite,
  getCollaborators,
  removeCollaborator,
  updateCollaboratorRole,
  transferOwnership,
  deletePlugin,
  deleteTheme,
  getDashboardPlugins,
  getDashboardThemes,
  getPendingInvitesForPlugin,
} from "../../src/lib/auth/collaborator-queries";

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const OWNER_ID = "cq-test-owner";
const COLLABORATOR_ID = "cq-test-collab";
const INVITEE_ID = "cq-test-invitee";
const PLUGIN_ID = "cq-test-plugin";
const PLUGIN_ID_2 = "cq-test-plugin-2";
const THEME_ID = "cq-test-theme";
const DELETE_PLUGIN_ID = "cq-del-plugin";
const DELETE_THEME_ID = "cq-del-theme";

beforeAll(async () => {
  await env.DB.batch([
    // Authors
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(OWNER_ID, 800001, "cq-owner"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(COLLABORATOR_ID, 800002, "cq-collab"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username) VALUES (?, ?, ?)",
    ).bind(INVITEE_ID, 800003, "cq-invitee"),

    // Plugins
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID, OWNER_ID, "CQ Test Plugin", "For collaborator query tests"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(PLUGIN_ID_2, OWNER_ID, "CQ Test Plugin 2", "Second test plugin"),

    // Theme
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(THEME_ID, OWNER_ID, "CQ Test Theme", "For collaborator query tests"),

    // Plugin to be deleted (with related records)
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugins (id, author_id, name, description, capabilities, keywords, installs_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', 5, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(DELETE_PLUGIN_ID, OWNER_ID, "Delete Plugin", "Will be deleted"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, checksum, screenshots, retry_count, source, created_at, updated_at)
       VALUES (?, ?, '1.0.0', 'published', 'bundles/del-plugin/1.0.0.tar.gz', '{}', 3, 1000, 5000, 'abc123', '[]', 0, 'upload', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("del-version-1", DELETE_PLUGIN_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_audits (id, plugin_version_id, verdict, risk_score, findings, model, prompt_tokens, completion_tokens, created_at)
       VALUES (?, ?, 'pass', 10, '[]', 'test', 100, 50, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("del-audit-1", "del-version-1"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO installs (id, plugin_id, created_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("del-install-1", DELETE_PLUGIN_ID),

    // Theme to be deleted
    env.DB.prepare(
      `INSERT OR IGNORE INTO themes (id, author_id, name, description, keywords, thumbnail_key, screenshot_keys, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 'themes/del-thumb.jpg', '["themes/del-ss1.jpg","themes/del-ss2.jpg"]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(DELETE_THEME_ID, OWNER_ID, "Delete Theme", "Will be deleted"),

    // Existing collaborator for role update / removal tests
    env.DB.prepare(
      `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind("cq-existing-collab", PLUGIN_ID, COLLABORATOR_ID),
  ]);
});

// ---------------------------------------------------------------------------
// Invite lifecycle
// ---------------------------------------------------------------------------

describe("invite lifecycle", () => {
  let inviteId: string;

  it("createInvite stores a pending invite with 30-day expiry", async () => {
    inviteId = await createInvite(env.DB, {
      pluginId: PLUGIN_ID,
      invitedGithubUsername: "cq-invitee",
      role: "maintainer",
      invitedBy: OWNER_ID,
      inviterGithubUsername: "cq-owner",
    });

    expect(typeof inviteId).toBe("string");
    expect(inviteId.length).toBeGreaterThan(0);

    // Verify the invite was stored
    const row = await env.DB.prepare(
      "SELECT * FROM plugin_invites WHERE id = ?",
    )
      .bind(inviteId)
      .first();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.role).toBe("maintainer");
    expect(row!.invited_github_username).toBe("cq-invitee");
  });

  it("createInvite rejects self-invite", async () => {
    await expect(
      createInvite(env.DB, {
        pluginId: PLUGIN_ID,
        invitedGithubUsername: "cq-owner",
        role: "maintainer",
        invitedBy: OWNER_ID,
        inviterGithubUsername: "cq-owner",
      }),
    ).rejects.toThrow(/cannot invite yourself/i);
  });

  it("createInvite rejects self-invite case-insensitively", async () => {
    await expect(
      createInvite(env.DB, {
        pluginId: PLUGIN_ID,
        invitedGithubUsername: "CQ-OWNER",
        role: "maintainer",
        invitedBy: OWNER_ID,
        inviterGithubUsername: "cq-owner",
      }),
    ).rejects.toThrow(/cannot invite yourself/i);
  });

  it("createInvite rejects duplicate pending invite", async () => {
    await expect(
      createInvite(env.DB, {
        pluginId: PLUGIN_ID,
        invitedGithubUsername: "cq-invitee",
        role: "maintainer",
        invitedBy: OWNER_ID,
        inviterGithubUsername: "cq-owner",
      }),
    ).rejects.toThrow(/pending invite already exists/i);
  });

  it("createInvite rejects invite for existing collaborator", async () => {
    await expect(
      createInvite(env.DB, {
        pluginId: PLUGIN_ID,
        invitedGithubUsername: "cq-collab",
        role: "maintainer",
        invitedBy: OWNER_ID,
        inviterGithubUsername: "cq-owner",
      }),
    ).rejects.toThrow(/already a collaborator/i);
  });

  it("getPendingInvitesForUser returns pending invites", async () => {
    const invites = await getPendingInvitesForUser(env.DB, "cq-invitee");
    expect(invites.length).toBeGreaterThanOrEqual(1);
    const invite = invites.find((i) => i.id === inviteId);
    expect(invite).toBeDefined();
    expect(invite!.pluginId).toBe(PLUGIN_ID);
    expect(invite!.role).toBe("maintainer");
  });

  it("getPendingInvitesForUser filters expired invites", async () => {
    // Insert an expired invite
    await env.DB.prepare(
      `INSERT INTO plugin_invites (id, plugin_id, invited_github_username, role, invited_by, status, created_at, expires_at)
       VALUES (?, ?, 'cq-invitee', 'contributor', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-1 day')))`,
    ).bind("expired-invite-1", PLUGIN_ID_2, OWNER_ID).run();

    const invites = await getPendingInvitesForUser(env.DB, "cq-invitee");
    const expiredInvite = invites.find((i) => i.id === "expired-invite-1");
    expect(expiredInvite).toBeUndefined();
  });

  it("acceptInvite creates collaborator and marks invite accepted", async () => {
    const result = await acceptInvite(env.DB, inviteId, INVITEE_ID);
    expect(result).toBeDefined();
    expect(result.pluginId).toBe(PLUGIN_ID);
    expect(result.role).toBe("maintainer");

    // Verify invite status
    const invite = await env.DB.prepare(
      "SELECT status FROM plugin_invites WHERE id = ?",
    )
      .bind(inviteId)
      .first();
    expect(invite!.status).toBe("accepted");

    // Verify collaborator record
    const collab = await env.DB.prepare(
      "SELECT * FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?",
    )
      .bind(PLUGIN_ID, INVITEE_ID)
      .first();
    expect(collab).not.toBeNull();
    expect(collab!.role).toBe("maintainer");
  });

  it("declineInvite marks invite as declined", async () => {
    // Create a new invite to decline
    const declineInviteId = await createInvite(env.DB, {
      pluginId: PLUGIN_ID_2,
      invitedGithubUsername: "cq-invitee",
      role: "contributor",
      invitedBy: OWNER_ID,
      inviterGithubUsername: "cq-owner",
    });

    await declineInvite(env.DB, declineInviteId, "cq-invitee");

    const invite = await env.DB.prepare(
      "SELECT status FROM plugin_invites WHERE id = ?",
    )
      .bind(declineInviteId)
      .first();
    expect(invite!.status).toBe("declined");
  });
});

// ---------------------------------------------------------------------------
// Collaborator CRUD
// ---------------------------------------------------------------------------

describe("collaborator CRUD", () => {
  it("getCollaborators returns owner and collaborators", async () => {
    const collaborators = await getCollaborators(env.DB, PLUGIN_ID);
    expect(collaborators.length).toBeGreaterThanOrEqual(2);

    const owner = collaborators.find((c) => c.role === "owner");
    expect(owner).toBeDefined();
    expect(owner!.authorId).toBe(OWNER_ID);

    const collab = collaborators.find((c) => c.authorId === COLLABORATOR_ID);
    expect(collab).toBeDefined();
    expect(collab!.role).toBe("contributor");
  });

  it("updateCollaboratorRole changes role in-place", async () => {
    await updateCollaboratorRole(env.DB, PLUGIN_ID, COLLABORATOR_ID, "maintainer");

    const row = await env.DB.prepare(
      "SELECT role FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?",
    )
      .bind(PLUGIN_ID, COLLABORATOR_ID)
      .first();
    expect(row!.role).toBe("maintainer");
  });

  it("removeCollaborator deletes the collaborator record", async () => {
    // Remove the collaborator we just updated
    await removeCollaborator(env.DB, PLUGIN_ID, COLLABORATOR_ID);

    const row = await env.DB.prepare(
      "SELECT * FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?",
    )
      .bind(PLUGIN_ID, COLLABORATOR_ID)
      .first();
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ownership transfer
// ---------------------------------------------------------------------------

describe("transferOwnership", () => {
  it("atomically transfers ownership and downgrades previous owner to maintainer", async () => {
    // Ensure invitee is a collaborator first (from the accept test above)
    const before = await env.DB.prepare(
      "SELECT author_id FROM plugins WHERE id = ?",
    )
      .bind(PLUGIN_ID)
      .first();
    expect(before!.author_id).toBe(OWNER_ID);

    await transferOwnership(env.DB, PLUGIN_ID, OWNER_ID, INVITEE_ID, "plugin");

    // New owner
    const after = await env.DB.prepare(
      "SELECT author_id FROM plugins WHERE id = ?",
    )
      .bind(PLUGIN_ID)
      .first();
    expect(after!.author_id).toBe(INVITEE_ID);

    // Old owner is now maintainer
    const oldOwner = await env.DB.prepare(
      "SELECT role FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?",
    )
      .bind(PLUGIN_ID, OWNER_ID)
      .first();
    expect(oldOwner).not.toBeNull();
    expect(oldOwner!.role).toBe("maintainer");

    // New owner is NOT in collaborators (they are the owner now)
    const newOwner = await env.DB.prepare(
      "SELECT * FROM plugin_collaborators WHERE plugin_id = ? AND author_id = ?",
    )
      .bind(PLUGIN_ID, INVITEE_ID)
      .first();
    expect(newOwner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cascade deletion
// ---------------------------------------------------------------------------

describe("deletePlugin", () => {
  it("cascades across all child tables", async () => {
    // Add collaborator and invite to the delete-target plugin
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
         VALUES (?, ?, ?, 'maintainer', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).bind("del-collab-1", DELETE_PLUGIN_ID, COLLABORATOR_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO plugin_invites (id, plugin_id, invited_github_username, role, invited_by, status, created_at, expires_at)
         VALUES (?, ?, 'someone', 'contributor', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '+30 days')))`,
      ).bind("del-invite-1", DELETE_PLUGIN_ID, OWNER_ID),
    ]);

    // Create a mock R2 bucket
    const deletedKeys: string[] = [];
    const mockR2 = {
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    } as unknown as R2Bucket;

    await deletePlugin(env.DB, mockR2, DELETE_PLUGIN_ID);

    // Verify all records are gone
    const plugin = await env.DB.prepare("SELECT * FROM plugins WHERE id = ?")
      .bind(DELETE_PLUGIN_ID)
      .first();
    expect(plugin).toBeNull();

    const versions = await env.DB.prepare(
      "SELECT * FROM plugin_versions WHERE plugin_id = ?",
    )
      .bind(DELETE_PLUGIN_ID)
      .all();
    expect(versions.results.length).toBe(0);

    const audits = await env.DB.prepare(
      "SELECT * FROM plugin_audits WHERE plugin_version_id = ?",
    )
      .bind("del-version-1")
      .all();
    expect(audits.results.length).toBe(0);

    const installs = await env.DB.prepare(
      "SELECT * FROM installs WHERE plugin_id = ?",
    )
      .bind(DELETE_PLUGIN_ID)
      .all();
    expect(installs.results.length).toBe(0);

    const collabs = await env.DB.prepare(
      "SELECT * FROM plugin_collaborators WHERE plugin_id = ?",
    )
      .bind(DELETE_PLUGIN_ID)
      .all();
    expect(collabs.results.length).toBe(0);

    const invites = await env.DB.prepare(
      "SELECT * FROM plugin_invites WHERE plugin_id = ?",
    )
      .bind(DELETE_PLUGIN_ID)
      .all();
    expect(invites.results.length).toBe(0);

    // Verify R2 cleanup was attempted
    expect(deletedKeys).toContain("bundles/del-plugin/1.0.0.tar.gz");
  });
});

describe("deleteTheme", () => {
  it("cascades and cleans up R2 screenshots", async () => {
    // Add collaborator and invite to the delete-target theme
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO plugin_collaborators (id, plugin_id, author_id, role, created_at, updated_at)
         VALUES (?, ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).bind("del-theme-collab-1", DELETE_THEME_ID, COLLABORATOR_ID),
    ]);

    const deletedKeys: string[] = [];
    const mockR2 = {
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    } as unknown as R2Bucket;

    await deleteTheme(env.DB, mockR2, DELETE_THEME_ID);

    // Verify theme is gone
    const theme = await env.DB.prepare("SELECT * FROM themes WHERE id = ?")
      .bind(DELETE_THEME_ID)
      .first();
    expect(theme).toBeNull();

    const collabs = await env.DB.prepare(
      "SELECT * FROM plugin_collaborators WHERE plugin_id = ?",
    )
      .bind(DELETE_THEME_ID)
      .all();
    expect(collabs.results.length).toBe(0);

    // Verify R2 cleanup of thumbnail and screenshots
    expect(deletedKeys).toContain("themes/del-thumb.jpg");
    expect(deletedKeys).toContain("themes/del-ss1.jpg");
    expect(deletedKeys).toContain("themes/del-ss2.jpg");
  });
});

// ---------------------------------------------------------------------------
// Dashboard queries
// ---------------------------------------------------------------------------

describe("getDashboardPlugins", () => {
  it("returns owned and collaborated plugins with role field", async () => {
    // INVITEE_ID is now the owner of PLUGIN_ID (from transfer test)
    // OWNER_ID is maintainer on PLUGIN_ID and owner of PLUGIN_ID_2
    const plugins = await getDashboardPlugins(env.DB, OWNER_ID);

    // Should include PLUGIN_ID_2 (owned) and PLUGIN_ID (maintainer)
    expect(plugins.length).toBeGreaterThanOrEqual(1);

    const owned = plugins.find((p) => p.id === PLUGIN_ID_2);
    if (owned) {
      expect(owned.role).toBe("owner");
    }

    const maintained = plugins.find((p) => p.id === PLUGIN_ID);
    if (maintained) {
      expect(maintained.role).toBe("maintainer");
    }
  });
});

describe("getDashboardThemes", () => {
  it("returns owned themes with role field", async () => {
    const themes = await getDashboardThemes(env.DB, OWNER_ID);
    const ownedTheme = themes.find((t) => t.id === THEME_ID);
    if (ownedTheme) {
      expect(ownedTheme.role).toBe("owner");
    }
  });
});

// ---------------------------------------------------------------------------
// getPendingInvitesForPlugin
// ---------------------------------------------------------------------------

describe("getPendingInvitesForPlugin", () => {
  it("returns pending non-expired invites for a plugin", async () => {
    // Create a fresh invite for PLUGIN_ID_2
    await createInvite(env.DB, {
      pluginId: PLUGIN_ID_2,
      invitedGithubUsername: "cq-collab",
      role: "maintainer",
      invitedBy: OWNER_ID,
      inviterGithubUsername: "cq-owner",
    });

    const invites = await getPendingInvitesForPlugin(env.DB, PLUGIN_ID_2);
    expect(invites.length).toBeGreaterThanOrEqual(1);
    const invite = invites.find(
      (i) => i.invitedGithubUsername === "cq-collab",
    );
    expect(invite).toBeDefined();
    expect(invite!.role).toBe("maintainer");
  });
});
