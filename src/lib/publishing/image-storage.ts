/**
 * Image validation and R2 storage utilities for theme screenshots and thumbnails.
 *
 * Validates MIME type and file size before upload. Stores images in R2 with
 * correct content-type metadata for the image proxy to serve.
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

/**
 * Validate an image file for upload. Checks MIME type and file size.
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
 * Store an image file in R2 with correct content-type metadata.
 */
export async function storeImageInR2(
  r2: R2Bucket,
  key: string,
  file: File,
): Promise<void> {
  const bytes = await file.arrayBuffer();
  await r2.put(key, bytes, {
    httpMetadata: { contentType: file.type },
  });
}
