import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  getPluginsByAuthor,
  getVersionDetail,
} from "../../src/lib/db/queries";
import { updatePluginMetadata } from "../../src/lib/publishing/plugin-queries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AUTHOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_AUTHOR_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const TEST_PLUGIN_ID = "test-dashboard-plugin";
const TEST_VERSION_ID = "vvvvvvvv-0000-0000-0000-000000000001";
const NO_AUDIT_VERSION_ID = "vvvvvvvv-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at)
       VALUES (?, 12345, 'testuser', 'https://avatars.githubusercontent.com/u/12345', 0,
       '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
    ).bind(TEST_AUTHOR_ID),
    env.DB.prepare(
      `INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at)
       VALUES (?, 67890, 'otheruser', 'https://avatars.githubusercontent.com/u/67890', 0,
       '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
    ).bind(OTHER_AUTHOR_ID),
    env.DB.prepare(
      `INSERT INTO plugins (id, author_id, name, description, capabilities, keywords, license, category,
       repository_url, homepage_url, support_url, funding_url, installs_count, created_at, updated_at)
       VALUES (?, ?, 'Test Plugin', 'A test plugin', '["storage:read"]', '["test"]', 'MIT', null,
       'https://github.com/test/plugin', null, null, null, 42, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
    ).bind(TEST_PLUGIN_ID, TEST_AUTHOR_ID),
    env.DB.prepare(
      `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest,
       file_count, compressed_size, decompressed_size, checksum, retry_count, created_at, updated_at)
       VALUES (?, ?, '1.0.0', 'published', 'bundles/test/1.0.0.tgz', '{}',
       5, 1024, 4096, 'abc123', 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
    ).bind(TEST_VERSION_ID, TEST_PLUGIN_ID),
    env.DB.prepare(
      `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest,
       file_count, compressed_size, decompressed_size, checksum, retry_count, created_at, updated_at)
       VALUES (?, ?, '0.9.0', 'pending', 'bundles/test/0.9.0.tgz', '{}',
       3, 512, 2048, 'def456', 1, '2024-12-01T00:00:00Z', '2024-12-01T00:00:00Z')`,
    ).bind(NO_AUDIT_VERSION_ID, TEST_PLUGIN_ID),
    env.DB.prepare(
      `INSERT INTO plugin_audits (id, plugin_version_id, status, model, neurons_used, verdict, risk_score, findings, created_at)
       VALUES ('auditid01-0000-0000-0000-000000000001', ?, 'completed', 'gemma-4-26b', 100, 'pass', 15,
       '[{"severity":"low","title":"Minor issue","description":"Test finding","category":"security","location":"index.js:1"}]',
       '2025-01-01T00:00:00Z')`,
    ).bind(TEST_VERSION_ID),
  ]);
});

// ---------------------------------------------------------------------------
// Dashboard queries
// ---------------------------------------------------------------------------

describe("Dashboard queries", () => {
  describe("getPluginsByAuthor", () => {
    it("returns plugins with latest version and status", async () => {
      const plugins = await getPluginsByAuthor(env.DB, TEST_AUTHOR_ID);

      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toEqual({
        id: TEST_PLUGIN_ID,
        name: "Test Plugin",
        latestVersion: "1.0.0",
        latestStatus: "published",
        installCount: 42,
        downloadCount: 0,
        updatedAt: "2025-01-01T00:00:00Z",
      });
    });

    it("returns empty array for author with no plugins", async () => {
      const plugins = await getPluginsByAuthor(env.DB, OTHER_AUTHOR_ID);
      expect(plugins).toEqual([]);
    });
  });

  describe("getVersionDetail", () => {
    it("returns version with parsed audit findings", async () => {
      const detail = await getVersionDetail(
        env.DB,
        TEST_PLUGIN_ID,
        "1.0.0",
      );

      expect(detail).not.toBeNull();
      expect(detail!.version).toBe("1.0.0");
      expect(detail!.status).toBe("published");
      expect(detail!.retryCount).toBe(0);
      expect(detail!.verdict).toBe("pass");
      expect(detail!.riskScore).toBe(15);
      expect(detail!.findings).toEqual([
        {
          severity: "low",
          title: "Minor issue",
          description: "Test finding",
          category: "security",
          location: "index.js:1",
        },
      ]);
    });

    it("returns null for non-existent version", async () => {
      const detail = await getVersionDetail(
        env.DB,
        TEST_PLUGIN_ID,
        "99.99.99",
      );
      expect(detail).toBeNull();
    });

    it("returns null verdict when no audit record exists", async () => {
      const detail = await getVersionDetail(
        env.DB,
        TEST_PLUGIN_ID,
        "0.9.0",
      );

      expect(detail).not.toBeNull();
      expect(detail!.version).toBe("0.9.0");
      expect(detail!.status).toBe("pending");
      expect(detail!.retryCount).toBe(1);
      expect(detail!.verdict).toBeNull();
      expect(detail!.riskScore).toBeNull();
      expect(detail!.findings).toEqual([]);
    });

    it("derives trustTier='unreviewed' for a pending version with no audits", async () => {
      const detail = await getVersionDetail(
        env.DB,
        TEST_PLUGIN_ID,
        "0.9.0",
      );
      expect(detail!.trustTier).toBe("unreviewed");
      expect(detail!.latestAuditModel).toBeNull();
      expect(detail!.adminRejectionReason).toBeNull();
    });

    it("surfaces latestAuditModel from the most recent audit record", async () => {
      const detail = await getVersionDetail(
        env.DB,
        TEST_PLUGIN_ID,
        "1.0.0",
      );
      // The seeded audit uses model 'gemma-4-26b'.
      expect(detail!.latestAuditModel).toBe("gemma-4-26b");
    });

    it("surfaces the admin rejection reason when an admin-action audit exists", async () => {
      // Seed a rejected version with an admin-action audit reason.
      const rejectedVersionId = "vvvvvvvv-0000-0000-0000-000000000003";
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest,
           file_count, compressed_size, decompressed_size, checksum, retry_count, created_at, updated_at)
           VALUES (?, ?, '0.8.0', 'rejected', 'bundles/test/0.8.0.tgz', '{}',
           5, 1024, 4096, 'ghi789', 0, '2024-11-01T00:00:00Z', '2024-11-01T00:00:00Z')`,
        ).bind(rejectedVersionId, TEST_PLUGIN_ID),
        env.DB.prepare(
          `INSERT INTO plugin_audits (id, plugin_version_id, status, model, neurons_used, verdict, risk_score, findings, raw_response, created_at)
           VALUES ('auditid02-0000-0000-0000-000000000002', ?, 'complete', 'admin-action', 0, NULL, 0,
           '[]', 'Insufficient test coverage for the capability declarations.',
           '2024-11-02T00:00:00Z')`,
        ).bind(rejectedVersionId),
      ]);

      const detail = await getVersionDetail(
        env.DB,
        TEST_PLUGIN_ID,
        "0.8.0",
      );
      expect(detail!.status).toBe("rejected");
      expect(detail!.trustTier).toBe("rejected");
      expect(detail!.adminRejectionReason).toBe(
        "Insufficient test coverage for the capability declarations.",
      );
    });
  });

  describe("updatePluginMetadata", () => {
    it("updates only provided fields", async () => {
      await updatePluginMetadata(env.DB, TEST_PLUGIN_ID, {
        description: "Updated description",
      });

      const row = await env.DB.prepare(
        "SELECT description, license, repository_url FROM plugins WHERE id = ?",
      )
        .bind(TEST_PLUGIN_ID)
        .first<{
          description: string;
          license: string;
          repository_url: string;
        }>();

      expect(row).not.toBeNull();
      expect(row!.description).toBe("Updated description");
      expect(row!.license).toBe("MIT");
      expect(row!.repository_url).toBe("https://github.com/test/plugin");
    });

    it("serializes keywords array as JSON", async () => {
      await updatePluginMetadata(env.DB, TEST_PLUGIN_ID, {
        keywords: ["dashboard", "testing", "new"],
      });

      const row = await env.DB.prepare(
        "SELECT keywords FROM plugins WHERE id = ?",
      )
        .bind(TEST_PLUGIN_ID)
        .first<{ keywords: string }>();

      expect(row).not.toBeNull();
      expect(JSON.parse(row!.keywords)).toEqual([
        "dashboard",
        "testing",
        "new",
      ]);
    });
  });
});
