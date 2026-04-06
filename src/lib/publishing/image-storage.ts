/**
 * Image validation and R2 storage utilities for theme screenshots and thumbnails.
 *
 * Validates MIME type, file size, and content magic bytes before upload.
 * Stores images in R2 with the verified content-type metadata.
 */

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

export const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** File signature (magic bytes) prefixes for each accepted MIME type. */
const MAGIC_BYTES: Record<string, number[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // WebP: RIFF....WEBP — bytes 0-3 are "RIFF", bytes 8-11 are "WEBP"
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
};

/**
 * Validate an image file's declared MIME type and size.
 * Sync because it only inspects File metadata, not contents.
 * Magic bytes are verified later in storeImageInR2.
 */
export function validateImageUpload(file: File): {
  valid: boolean;
  error?: string;
} {
  if (
    !(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)
  ) {
    return { valid: false, error: "Only JPEG, PNG, and WebP images are accepted." };
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return { valid: false, error: "Each image must be under 5MB." };
  }

  return { valid: true };
}

/**
 * Verify that a byte buffer's magic bytes match the declared MIME type.
 * Defends against spoofed Content-Type headers on multipart uploads.
 */
export function verifyImageMagicBytes(
  bytes: ArrayBuffer,
  declaredType: string,
): boolean {
  const signatures = MAGIC_BYTES[declaredType];
  if (!signatures) return false;

  const view = new Uint8Array(bytes);

  for (const sig of signatures) {
    if (view.length < sig.length) continue;
    let matches = true;
    for (let i = 0; i < sig.length; i++) {
      if (view[i] !== sig[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      // For WebP, also verify bytes 8-11 spell "WEBP"
      if (declaredType === "image/webp") {
        if (view.length < 12) return false;
        if (
          view[8] !== 0x57 ||
          view[9] !== 0x45 ||
          view[10] !== 0x42 ||
          view[11] !== 0x50
        ) {
          return false;
        }
      }
      return true;
    }
  }
  return false;
}

/**
 * Store an image file in R2 after verifying its magic bytes match the
 * declared MIME type. Throws if the content does not match — protects
 * against attackers uploading executable/HTML payloads with image/* types.
 */
export async function storeImageInR2(
  r2: R2Bucket,
  key: string,
  file: File,
): Promise<void> {
  const bytes = await file.arrayBuffer();

  if (!verifyImageMagicBytes(bytes, file.type)) {
    throw new Error("Image content does not match declared type.");
  }

  await r2.put(key, bytes, {
    httpMetadata: { contentType: file.type },
  });
}
