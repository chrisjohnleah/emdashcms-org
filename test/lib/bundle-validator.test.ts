import { describe, it, expect } from "vitest";
import { packTar, createGzipEncoder } from "modern-tar";
import { manifestSchema } from "../../src/lib/publishing/manifest-schema";
import {
  validateBundle,
  computeSha256,
} from "../../src/lib/publishing/bundle-validator";
import { toISOTimestamp } from "../../src/lib/publishing/timestamp";

// ---------------------------------------------------------------------------
// Test helper: create a .tgz (gzipped tar) from a file map
// ---------------------------------------------------------------------------

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
  const compressed = await new Response(stream).arrayBuffer();
  return compressed;
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-plugin",
    version: "1.0.0",
    capabilities: [],
    allowedHosts: [],
    hooks: [],
    routes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// manifestSchema
// ---------------------------------------------------------------------------

describe("manifestSchema", () => {
  it("accepts valid minimal manifest", () => {
    const result = manifestSchema.safeParse(validManifest());
    expect(result.success).toBe(true);
  });

  it("accepts scoped plugin id", () => {
    const result = manifestSchema.safeParse(
      validManifest({ id: "@my-org/my-plugin" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects missing id field", () => {
    const { id: _, ...noId } = validManifest();
    const result = manifestSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it("rejects invalid version format '1.0'", () => {
    const result = manifestSchema.safeParse(
      validManifest({ version: "1.0" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts valid version '1.0.0'", () => {
    const result = manifestSchema.safeParse(
      validManifest({ version: "1.0.0" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects uppercase plugin id 'MyPlugin'", () => {
    const result = manifestSchema.safeParse(
      validManifest({ id: "MyPlugin" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts empty capabilities array", () => {
    const result = manifestSchema.safeParse(
      validManifest({ capabilities: [] }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts manifest with optional fields", () => {
    const result = manifestSchema.safeParse(
      validManifest({
        name: "Test Plugin",
        description: "A test plugin",
        changelog: "Initial release",
        minEmDashVersion: "1.0.0",
        admin: { entry: "admin/index.js" },
        storage: { key: "value" },
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateBundle
// ---------------------------------------------------------------------------

describe("validateBundle", () => {
  it("validates a correct tarball with manifest.json", async () => {
    const manifest = validManifest();
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "backend.js": "export default {}",
    });

    const result = await validateBundle(tarball, "test-plugin");

    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.id).toBe("test-plugin");
    expect(result.files!.size).toBe(2);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stats!.fileCount).toBe(2);
    expect(result.stats!.compressedSize).toBeGreaterThan(0);
    expect(result.stats!.decompressedSize).toBeGreaterThan(0);
  });

  it("rejects tarball missing manifest.json", async () => {
    const tarball = await createTestTarball({
      "backend.js": "export default {}",
    });

    const result = await validateBundle(tarball, "test-plugin");

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("manifest.json"))).toBe(true);
  });

  it("rejects manifest id mismatch with expected plugin id", async () => {
    const manifest = validManifest({ id: "wrong-id" });
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
    });

    const result = await validateBundle(tarball, "expected-id");

    expect(result.valid).toBe(false);
    expect(
      result.errors!.some((e) => e.includes("does not match")),
    ).toBe(true);
  });

  it("rejects path traversal in tarball entries", async () => {
    const manifest = validManifest();
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "../evil.js": "malicious code",
    });

    const result = await validateBundle(tarball, "test-plugin");

    expect(result.valid).toBe(false);
    expect(
      result.errors!.some((e) => e.includes("path traversal") || e.includes("Invalid path")),
    ).toBe(true);
  });

  it("rejects manifest with admin.entry pointing to missing file (D-14)", async () => {
    const manifest = validManifest({
      admin: { entry: "admin/index.js" },
    });
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "backend.js": "export default {}",
    });

    const result = await validateBundle(tarball, "test-plugin");

    expect(result.valid).toBe(false);
    expect(
      result.errors!.some(
        (e) => e.includes("entry point") || e.includes("not found in bundle"),
      ),
    ).toBe(true);
  });

  it("accepts manifest with admin.entry when file exists", async () => {
    const manifest = validManifest({
      admin: { entry: "admin/index.js" },
    });
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "admin/index.js": "export default {}",
    });

    const result = await validateBundle(tarball, "test-plugin");

    expect(result.valid).toBe(true);
  });

  it("returns stats with correct file count and sizes", async () => {
    const content = "x".repeat(100);
    const manifest = validManifest();
    const tarball = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      "file1.js": content,
      "file2.js": content,
    });

    const result = await validateBundle(tarball, "test-plugin");

    expect(result.valid).toBe(true);
    expect(result.stats!.fileCount).toBe(3);
    expect(result.stats!.decompressedSize).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeSha256
// ---------------------------------------------------------------------------

describe("computeSha256", () => {
  it("returns consistent 64-character hex string", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash1 = await computeSha256(data.buffer);
    const hash2 = await computeSha256(data.buffer);

    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// toISOTimestamp
// ---------------------------------------------------------------------------

describe("toISOTimestamp", () => {
  it("normalizes old datetime format to ISO 8601", () => {
    expect(toISOTimestamp("2026-04-04 12:00:00")).toBe(
      "2026-04-04T12:00:00Z",
    );
  });

  it("passes through ISO 8601 timestamps unchanged", () => {
    expect(toISOTimestamp("2026-04-04T12:00:00Z")).toBe(
      "2026-04-04T12:00:00Z",
    );
  });
});
