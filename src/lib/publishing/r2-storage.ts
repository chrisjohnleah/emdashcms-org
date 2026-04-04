/**
 * R2 storage helper for plugin bundles.
 *
 * Stores tarballs at the key pattern: plugins/{pluginId}/{version}/bundle.tgz (D-10).
 * Scoped IDs like @scope/name are valid R2 keys (Pitfall 9 in research).
 */

/**
 * Store a plugin bundle tarball in R2 with integrity verification.
 * Returns the R2 key for use in D1 version records.
 */
export async function storeBundleInR2(
  r2: R2Bucket,
  pluginId: string,
  version: string,
  tarballBytes: ArrayBuffer,
  checksum: string,
): Promise<{ key: string }> {
  const key = `plugins/${pluginId}/${version}/bundle.tgz`;

  await r2.put(key, tarballBytes, {
    sha256: checksum,
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { pluginId, version },
  });

  return { key };
}
