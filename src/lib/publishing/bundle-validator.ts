import { unpackTar, createGzipDecoder } from "modern-tar";
import {
  manifestSchema,
  formatManifestErrors,
  type ValidatedManifest,
} from "./manifest-schema";

/** Maximum compressed tarball size: 10 MB */
const MAX_COMPRESSED = 10 * 1024 * 1024;

/** Maximum total decompressed size: 50 MB */
const MAX_DECOMPRESSED = 50 * 1024 * 1024;

/** Maximum number of files in the bundle */
const MAX_FILES = 200;

/** Maximum size for any single file: 5 MB */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface BundleValidationResult {
  valid: boolean;
  manifest?: ValidatedManifest;
  files?: Map<string, Uint8Array>;
  errors?: string[];
  stats?: { fileCount: number; compressedSize: number; decompressedSize: number };
  checksum?: string;
}

/**
 * Compute SHA-256 hash of a buffer, returned as a lowercase hex string.
 * Uses the Web Crypto API (available in Workers and Node 20+).
 */
export async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Check if a file path contains traversal attacks or is absolute.
 */
function isUnsafePath(name: string): boolean {
  if (name.startsWith("/")) return true;
  const segments = name.split("/");
  return segments.some((seg) => seg === "..");
}

/**
 * Strip common leading prefixes from tar entry names.
 * Tarballs often prefix entries with "./" which we normalize away.
 */
function normalizePath(name: string): string {
  if (name.startsWith("./")) return name.slice(2);
  return name;
}

/**
 * Validate a plugin bundle tarball (.tgz).
 *
 * Performs the following checks in order:
 * 1. Compressed size limit (10 MB)
 * 2. Path traversal / absolute path detection
 * 3. Per-file size limit (5 MB)
 * 4. Decompressed size limit (50 MB)
 * 5. File count limit (200)
 * 6. manifest.json presence and Zod schema validation
 * 7. Plugin ID match (supply chain check, D-13)
 * 8. Admin entry point existence (D-14)
 * 9. SHA-256 checksum computation
 */
export async function validateBundle(
  tarballBytes: ArrayBuffer,
  expectedPluginId: string,
): Promise<BundleValidationResult> {
  const compressedSize = tarballBytes.byteLength;

  // 1. Compressed size check
  if (compressedSize > MAX_COMPRESSED) {
    return {
      valid: false,
      errors: [
        `Tarball exceeds 10MB compressed limit (${(compressedSize / 1024 / 1024).toFixed(1)}MB)`,
      ],
    };
  }

  // 2-5. Extract and validate entries
  const files = new Map<string, Uint8Array>();
  let decompressedSize = 0;

  try {
    const stream = new Blob([tarballBytes]).stream();
    const entries = await unpackTar(
      stream.pipeThrough(createGzipDecoder()),
    );

    for (const entry of entries) {
      const name = normalizePath(entry.header.name);

      // Skip directories (they have no data)
      if (entry.header.type === "directory" || name.endsWith("/")) {
        continue;
      }

      // Path traversal check (Pitfall 4)
      if (isUnsafePath(name)) {
        return {
          valid: false,
          errors: [`Invalid path in bundle: "${name}" — path traversal or absolute paths are not allowed`],
        };
      }

      const data = entry.data ?? new Uint8Array(0);

      // Per-file size check
      if (data.byteLength > MAX_FILE_SIZE) {
        return {
          valid: false,
          errors: [
            `File "${name}" exceeds 5MB per-file limit (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`,
          ],
        };
      }

      decompressedSize += data.byteLength;
      files.set(name, data);
    }
  } catch (err) {
    return {
      valid: false,
      errors: [
        `Failed to extract tarball: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // Decompressed size check
  if (decompressedSize > MAX_DECOMPRESSED) {
    return {
      valid: false,
      errors: [
        `Bundle exceeds 50MB decompressed limit (${(decompressedSize / 1024 / 1024).toFixed(1)}MB)`,
      ],
    };
  }

  // File count check
  if (files.size > MAX_FILES) {
    return {
      valid: false,
      errors: [`Bundle contains ${files.size} files, exceeding the 200 file limit`],
    };
  }

  // 6. manifest.json presence
  if (!files.has("manifest.json")) {
    return {
      valid: false,
      errors: ["Bundle must contain manifest.json"],
    };
  }

  // Parse and validate manifest
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(files.get("manifest.json")!));
  } catch {
    return {
      valid: false,
      errors: ["manifest.json contains invalid JSON"],
    };
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      valid: false,
      errors: formatManifestErrors(result.error),
    };
  }

  const manifest = result.data;

  // 7. Supply chain check (D-13): manifest id must match registered plugin
  if (manifest.id !== expectedPluginId) {
    return {
      valid: false,
      errors: [
        `Manifest id '${manifest.id}' does not match registered plugin id '${expectedPluginId}'`,
      ],
    };
  }

  // 8. Admin entry point validation (D-14)
  if (manifest.admin?.entry) {
    if (!files.has(manifest.admin.entry)) {
      return {
        valid: false,
        errors: [
          `Admin entry point '${manifest.admin.entry}' declared in manifest but not found in bundle`,
        ],
      };
    }
  }

  // 9. Compute checksum
  const checksum = await computeSha256(tarballBytes);

  return {
    valid: true,
    manifest,
    files,
    stats: {
      fileCount: files.size,
      compressedSize,
      decompressedSize,
    },
    checksum,
  };
}
