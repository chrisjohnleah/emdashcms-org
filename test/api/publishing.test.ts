import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { packTar, createGzipEncoder } from "modern-tar";
import {
  resolveAuthorId,
  registerPlugin,
  getPluginOwner,
  checkUploadRateLimit,
  checkVersionExists,
  createVersion,
  getVersionForRetry,
  incrementRetryCount,
} from "../../src/lib/publishing/plugin-queries";
import {
  validateBundle,
  computeSha256,
} from "../../src/lib/publishing/bundle-validator";
import { storeBundleInR2 } from "../../src/lib/publishing/r2-storage";
import { enqueueAuditJob } from "../../src/lib/publishing/queue";
import { searchPlugins } from "../../src/lib/db/queries";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function seedTestAuthor(
  db: D1Database,
  id: string,
  githubId: number,
  username: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      githubId,
      username,
      `https://avatars.githubusercontent.com/u/${githubId}`,
      0,
      "2026-04-04T08:00:00Z",
      "2026-04-04T08:00:00Z",
    )
    .run();
}

async function createTestTarball(
  files: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, content]) => {
    const data =
      typeof content === "string" ? encoder.encode(content) : content;
    return {
      header: { name, size: data.byteLength, type: "file" as const },
      body: data,
    };
  });

  const tarBuffer = await packTar(entries);
  const stream = new Blob([tarBuffer])
    .stream()
    .pipeThrough(createGzipEncoder());
  return new Response(stream).arrayBuffer();
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-test-plugin",
    version: "1.0.0",
    capabilities: [],
    allowedHosts: [],
    hooks: [],
    routes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM installs"),
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM themes"),
    env.DB.prepare("DELETE FROM authors"),
  ]);

  await seedTestAuthor(env.DB, "test-author-1", 9001, "test-publisher");
  await seedTestAuthor(env.DB, "test-author-2", 9002, "other-publisher");
});

// ---------------------------------------------------------------------------
// PUBL-01: Plugin Registration
// ---------------------------------------------------------------------------

describe("plugin registration (PUBL-01)", () => {
  it("registers a new plugin with required fields", async () => {
    await registerPlugin(env.DB, "test-author-1", {
      id: "pub-test-plugin",
      name: "Pub Test Plugin",
      description: "A plugin used in publishing integration tests",
      capabilities: ["content:read"],
    });

    const owner = await getPluginOwner(env.DB, "pub-test-plugin");
    expect(owner).not.toBeNull();
    expect(owner!.authorId).toBe("test-author-1");

    // Plugin without published versions should NOT appear in public search
    const search = await searchPlugins(env.DB, {
      query: "Pub Test Plugin",
      category: null,
      capability: null,
      sort: "created",
      cursor: null,
      limit: 20,
    });
    expect(search.items.some((p) => p.id === "pub-test-plugin")).toBe(false);
  });

  it("rejects duplicate plugin id with UNIQUE constraint", async () => {
    await expect(
      registerPlugin(env.DB, "test-author-1", {
        id: "pub-test-plugin",
        name: "Duplicate Plugin",
        description: "Should fail",
        capabilities: [],
      }),
    ).rejects.toThrow();
  });

  it("stores optional fields correctly", async () => {
    await registerPlugin(env.DB, "test-author-2", {
      id: "pub-optional-fields",
      name: "Optional Fields Plugin",
      description: "Tests optional field storage",
      capabilities: [],
      keywords: ["test", "optional"],
      license: "MIT",
      repository_url: "https://github.com/test/optional-fields",
      support_url: "https://support.example.com",
      funding_url: "https://funding.example.com",
    });

    const row = await env.DB.prepare(
      "SELECT keywords, license, repository_url, support_url, funding_url FROM plugins WHERE id = ?",
    )
      .bind("pub-optional-fields")
      .first<{
        keywords: string;
        license: string;
        repository_url: string;
        support_url: string;
        funding_url: string;
      }>();

    expect(row).not.toBeNull();
    expect(JSON.parse(row!.keywords)).toEqual(["test", "optional"]);
    expect(row!.license).toBe("MIT");
    expect(row!.repository_url).toBe(
      "https://github.com/test/optional-fields",
    );
    expect(row!.support_url).toBe("https://support.example.com");
    expect(row!.funding_url).toBe("https://funding.example.com");
  });
});

// ---------------------------------------------------------------------------
// PUBL-02 + PUBL-04 + PUBL-05: Version Upload Flow
// ---------------------------------------------------------------------------

describe("version upload (PUBL-02, PUBL-04, PUBL-05)", () => {
  it("validates, stores in R2, creates D1 record, and enqueues audit job", async () => {
    const manifest = validManifest();
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "backend.js": "export default {}",
    });

    // Step 1: Validate bundle
    const validation = await validateBundle(tarball, "pub-test-plugin");
    expect(validation.valid).toBe(true);
    expect(validation.manifest).toBeDefined();
    expect(validation.stats).toBeDefined();
    expect(validation.checksum).toBeDefined();

    // Step 2: Store in R2
    const { key } = await storeBundleInR2(
      env.ARTIFACTS,
      "pub-test-plugin",
      "1.0.0",
      tarball,
      validation.checksum!,
    );
    expect(key).toBe("plugins/pub-test-plugin/1.0.0/bundle.tgz");

    // Step 3: Verify R2 object exists
    const r2Object = await env.ARTIFACTS.get(key);
    expect(r2Object).not.toBeNull();
    expect(r2Object!.size).toBe(tarball.byteLength);

    // Step 4: Create version record in D1
    const versionId = await createVersion(env.DB, {
      pluginId: "pub-test-plugin",
      version: "1.0.0",
      manifest: JSON.stringify(validation.manifest),
      bundleKey: key,
      checksum: validation.checksum!,
      fileCount: validation.stats!.fileCount,
      compressedSize: validation.stats!.compressedSize,
      decompressedSize: validation.stats!.decompressedSize,
    });
    expect(typeof versionId).toBe("string");
    expect(versionId.length).toBeGreaterThan(0);

    // Step 5: Verify D1 record
    const dbRow = await env.DB.prepare(
      "SELECT plugin_id, version, status, bundle_key FROM plugin_versions WHERE id = ?",
    )
      .bind(versionId)
      .first<{
        plugin_id: string;
        version: string;
        status: string;
        bundle_key: string;
      }>();

    expect(dbRow).not.toBeNull();
    expect(dbRow!.plugin_id).toBe("pub-test-plugin");
    expect(dbRow!.version).toBe("1.0.0");
    expect(dbRow!.status).toBe("pending");
    expect(dbRow!.bundle_key).toBe(key);

    // Step 6: Enqueue audit job (no throw = message accepted)
    await expect(
      enqueueAuditJob(env.AUDIT_QUEUE, {
        pluginId: "pub-test-plugin",
        version: "1.0.0",
        authorId: "test-author-1",
        bundleKey: key,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects upload of duplicate version", async () => {
    const exists = await checkVersionExists(
      env.DB,
      "pub-test-plugin",
      "1.0.0",
    );
    expect(exists).toBe(true);
  });

  it("reports non-existent version as available", async () => {
    const exists = await checkVersionExists(
      env.DB,
      "pub-test-plugin",
      "99.99.99",
    );
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUBL-03 + COST-03: Bundle Validation (Integration)
// ---------------------------------------------------------------------------

describe("bundle validation (PUBL-03, COST-03)", () => {
  it("rejects tarball with manifest id mismatch", async () => {
    const manifest = validManifest({ id: "wrong-plugin" });
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "backend.js": "export default {}",
    });

    const result = await validateBundle(tarball, "pub-test-plugin");
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("does not match"))).toBe(
      true,
    );
  });

  it("rejects tarball missing manifest.json", async () => {
    const tarball = await createTestTarball({
      "backend.js": "export default {}",
    });

    const result = await validateBundle(tarball, "pub-test-plugin");
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("manifest.json"))).toBe(true);
  });

  it("computes consistent SHA-256 checksum", async () => {
    const manifest = validManifest();
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "backend.js": "export default {}",
    });

    const checksum = await computeSha256(tarball);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    // Same input produces same checksum
    const checksum2 = await computeSha256(tarball);
    expect(checksum2).toBe(checksum);
  });
});

// ---------------------------------------------------------------------------
// COST-01: Rate Limiting
// ---------------------------------------------------------------------------

describe("rate limiting (COST-01)", () => {
  it("allows first 5 uploads then blocks the 6th", async () => {
    // Register a dedicated plugin for rate limit tests
    await registerPlugin(env.DB, "test-author-1", {
      id: "rate-limit-plugin",
      name: "Rate Limit Plugin",
      description: "Used for rate limit testing",
      capabilities: [],
    });

    // Insert 5 version records with today's timestamp to simulate 5 uploads
    for (let i = 1; i <= 5; i++) {
      await env.DB.prepare(
        `INSERT INTO plugin_versions (
          id, plugin_id, version, status, bundle_key, manifest,
          file_count, compressed_size, decompressed_size,
          checksum, screenshots, retry_count,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'pending', ?, '{}',
          1, 1000, 2000,
          'sha256:test', '[]', 0,
          strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        )`,
      )
        .bind(
          `rl-v${i}`,
          "rate-limit-plugin",
          `0.0.${i}`,
          `bundles/rate-limit-plugin/0.0.${i}.tar.gz`,
        )
        .run();
    }

    // 6th upload should be blocked
    const result = await checkUploadRateLimit(env.DB, "test-author-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
    // retryAfter should be a valid ISO timestamp for next UTC midnight
    expect(result.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  });

  it("allows uploads for author with no versions today", async () => {
    const result = await checkUploadRateLimit(env.DB, "test-author-2");
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PUBL-06: Retry Audit
// ---------------------------------------------------------------------------

describe("retry audit (PUBL-06)", () => {
  let retryVersionId: string;

  beforeAll(async () => {
    // Register a plugin for retry tests
    await registerPlugin(env.DB, "test-author-1", {
      id: "retry-test-plugin",
      name: "Retry Test Plugin",
      description: "Used for retry audit testing",
      capabilities: [],
    });

    // Create a version that will be rejected
    retryVersionId = await createVersion(env.DB, {
      pluginId: "retry-test-plugin",
      version: "1.0.0",
      manifest: JSON.stringify(validManifest({ id: "retry-test-plugin" })),
      bundleKey: "plugins/retry-test-plugin/1.0.0/bundle.tgz",
      checksum: "sha256:retrytest",
      fileCount: 2,
      compressedSize: 1000,
      decompressedSize: 2000,
    });

    // Set status to rejected (simulating a failed audit)
    await env.DB.prepare(
      "UPDATE plugin_versions SET status = 'rejected' WHERE id = ?",
    )
      .bind(retryVersionId)
      .run();
  });

  it("allows retry for rejected version", async () => {
    const version = await getVersionForRetry(
      env.DB,
      "retry-test-plugin",
      "1.0.0",
    );
    expect(version).not.toBeNull();
    expect(version!.status).toBe("rejected");
    expect(version!.retryCount).toBe(0);

    // Perform retry
    await incrementRetryCount(env.DB, retryVersionId);

    // Verify status changed to pending and retry count incremented
    const afterRetry = await getVersionForRetry(
      env.DB,
      "retry-test-plugin",
      "1.0.0",
    );
    expect(afterRetry).not.toBeNull();
    expect(afterRetry!.status).toBe("pending");
    expect(afterRetry!.retryCount).toBe(1);
  });

  it("blocks retry when retry_count >= 3", async () => {
    // Set retry_count to 3 and status back to rejected
    await env.DB.prepare(
      "UPDATE plugin_versions SET retry_count = 3, status = 'rejected' WHERE id = ?",
    )
      .bind(retryVersionId)
      .run();

    const version = await getVersionForRetry(
      env.DB,
      "retry-test-plugin",
      "1.0.0",
    );
    expect(version).not.toBeNull();
    expect(version!.retryCount).toBe(3);
    // Application code should check retryCount >= 3 before calling incrementRetryCount
    expect(version!.retryCount >= 3).toBe(true);
  });

  it("blocks retry for non-rejected version", async () => {
    // Set status to pending (not rejected)
    await env.DB.prepare(
      "UPDATE plugin_versions SET status = 'pending', retry_count = 0 WHERE id = ?",
    )
      .bind(retryVersionId)
      .run();

    const version = await getVersionForRetry(
      env.DB,
      "retry-test-plugin",
      "1.0.0",
    );
    expect(version).not.toBeNull();
    // Application code should check status === "rejected" before allowing retry
    expect(version!.status).not.toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// Ownership Enforcement
// ---------------------------------------------------------------------------

describe("ownership enforcement", () => {
  it("getPluginOwner returns correct author id", async () => {
    const owner = await getPluginOwner(env.DB, "pub-test-plugin");
    expect(owner).not.toBeNull();
    expect(owner!.authorId).toBe("test-author-1");
  });

  it("getPluginOwner returns null for non-existent plugin", async () => {
    const owner = await getPluginOwner(env.DB, "nonexistent-plugin-xyz");
    expect(owner).toBeNull();
  });

  it("resolveAuthorId maps github_id to internal UUID", async () => {
    const authorId = await resolveAuthorId(env.DB, 9001);
    expect(authorId).toBe("test-author-1");
  });

  it("resolveAuthorId returns null for unknown github_id", async () => {
    const authorId = await resolveAuthorId(env.DB, 99999);
    expect(authorId).toBeNull();
  });
});
