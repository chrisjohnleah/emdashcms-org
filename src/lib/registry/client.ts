/**
 * Read-only client for the official EmDash plugin registry
 * (registry.emdashcms.com, atproto XRPC). Upstream labels the API
 * "experimental — shapes may change without notice", so every field is
 * normalised defensively and any failure degrades to "no registry data"
 * instead of a 500.
 *
 * Plain fetch, no @emdash-cms/registry-client dependency. Responses are
 * `private, no-store` upstream, so we force a short edge cache via
 * cf.cacheTtl.
 */

const XRPC = "https://registry.emdashcms.com/xrpc/com.emdashcms.experimental.aggregator.";
const CACHE_TTL = 900;

// ponytail: fixture packages upstream publishes for its own tests; a
// label-based filter would be better if upstream ever adds one.
const FIXTURE_SLUGS = new Set(["marketplace-test"]);

export interface RegistryPackage {
  did: string;
  handle: string;
  slug: string;
  /** `@handle/slug` — the name admins search for in the Registry UI. */
  publicName: string;
  name: string;
  description: string;
  license: string | null;
  keywords: string[];
  authors: Array<{ name: string; url: string | null }>;
  repository: string | null;
  latestVersion: string | null;
  lastUpdated: string | null;
  /** Markdown sections supplied by the publisher (description, installation, …). */
  sections: Record<string, string>;
  officialUrl: string;
}

export interface RegistryAccess {
  /** Permission area, e.g. "content", "network", "email". */
  area: string;
  /** Operations within the area, e.g. ["read", "write"]. */
  operations: string[];
  /** Hosts for network.request, when declared. */
  hosts: string[];
}

export interface RegistryRelease {
  version: string;
  requires: string | null;
  access: RegistryAccess[];
  /** CDN URL of the release's .tgz bundle, or null if it can't be built safely. */
  bundleUrl: string | null;
  bundleSize: number | null;
}

type Fetcher = typeof fetch;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** Only http(s) URLs from registry data may be rendered as links. */
export const safeUrl = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

const titleCase = (slug: string) =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function normalisePackage(raw: unknown): RegistryPackage | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const did = str(p.did);
  const handle = str(p.handle);
  const slug = str(p.slug);
  if (!did || !handle || !slug || FIXTURE_SLUGS.has(slug)) return null;
  if (!/^[a-z0-9.-]+$/i.test(handle) || !/^[a-z0-9._-]+$/i.test(slug)) return null;

  const profile = (p.profile && typeof p.profile === "object" ? p.profile : {}) as Record<string, unknown>;
  const sectionsRaw = (profile.sections && typeof profile.sections === "object" ? profile.sections : {}) as Record<string, unknown>;
  const sections: Record<string, string> = {};
  for (const [k, v] of Object.entries(sectionsRaw)) {
    const s = str(v);
    if (s) sections[k] = s;
  }
  const ext = (profile.extensions ?? {}) as Record<string, Record<string, unknown> | undefined>;

  return {
    did,
    handle,
    slug,
    publicName: `@${handle}/${slug}`,
    name: str(profile.name) ?? titleCase(slug),
    description: str(profile.description) ?? "",
    license: str(profile.license),
    keywords: Array.isArray(profile.keywords) ? profile.keywords.filter((k): k is string => typeof k === "string") : [],
    authors: Array.isArray(profile.authors)
      ? profile.authors
          .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))
          .filter((a) => str(a.name))
          .map((a) => ({ name: a.name as string, url: safeUrl(a.url) }))
      : [],
    repository: safeUrl(ext["com.emdashcms.experimental.package.profileExtension"]?.repository),
    latestVersion: str(p.latestVersion),
    lastUpdated: str(profile.lastUpdated) ?? str(p.indexedAt),
    sections,
    officialUrl: `https://plugins.emdashcms.com/plugins/@${handle}/${slug}`,
  };
}

export function normaliseRelease(raw: unknown): RegistryRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const version = str(r.version);
  if (!version) return null;
  const release = (r.release ?? {}) as Record<string, unknown>;
  const requires = (release.requires ?? {}) as Record<string, unknown>;
  const ext = (release.extensions ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const declared = ext["com.emdashcms.experimental.package.releaseExtension"]?.declaredAccess;

  const access: RegistryAccess[] = [];
  if (declared && typeof declared === "object") {
    for (const [area, ops] of Object.entries(declared as Record<string, unknown>)) {
      if (!ops || typeof ops !== "object") continue;
      const opsObj = ops as Record<string, unknown>;
      const request = opsObj.request as Record<string, unknown> | undefined;
      access.push({
        area,
        operations: Object.keys(opsObj),
        hosts: Array.isArray(request?.allowedHosts)
          ? request.allowedHosts.filter((h): h is string => typeof h === "string")
          : [],
      });
    }
  }
  return { version, requires: str(requires["env:emdash"]), access, ...bundleLocation(r, release) };
}

const CID = /^[a-z0-9]+$/i;

/**
 * Bundle URL format (verified against cdn.em-da.sh):
 *   {cache}/r/{did}/{collection}/{rkey}/{releaseRecordCid}/{blobCid}
 * The rkey's `slug:version` colon must NOT be URL-encoded (encoding → 400).
 */
function bundleLocation(
  r: Record<string, unknown>,
  release: Record<string, unknown>,
): { bundleUrl: string | null; bundleSize: number | null } {
  const none = { bundleUrl: null, bundleSize: null };
  const artifacts = (release.artifacts ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const blob = (artifacts.package?.blob ?? {}) as Record<string, unknown>;
  const blobCid = str((blob.ref as Record<string, unknown> | undefined)?.$link);
  const recordCid = str(r.cid);
  const uri = str(r.uri);
  const caches = Array.isArray(r.artifactCaches) ? r.artifactCaches : [];
  const endpoint = safeUrl((caches[0] as Record<string, unknown> | undefined)?.serviceEndpoint);
  if (!blobCid || !recordCid || !uri || !endpoint || !CID.test(blobCid) || !CID.test(recordCid)) return none;
  if (!endpoint.startsWith("https://")) return none;

  const m = /^at:\/\/(did:[a-z0-9:._-]+)\/([a-z0-9.]+)\/([a-z0-9._:-]+)$/i.exec(uri);
  if (!m) return none;
  const [, did, collection, rkey] = m;
  return {
    bundleUrl: `${endpoint.replace(/\/+$/, "")}/r/${did}/${collection}/${rkey}/${recordCid}/${blobCid}`,
    bundleSize: typeof blob.size === "number" ? blob.size : null,
  };
}

async function xrpc(method: string, params: Record<string, string>, fetcher: Fetcher): Promise<unknown | null> {
  try {
    const res = await fetcher(`${XRPC}${method}?${new URLSearchParams(params)}`, {
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    } as RequestInit);
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error(`[registry] ${method} failed:`, err);
    return null;
  }
}

/** Every listed registry package, newest first. Empty on any failure. */
export async function listRegistryPackages(fetcher: Fetcher = fetch): Promise<RegistryPackage[]> {
  const out: RegistryPackage[] = [];
  let cursor: string | undefined;
  // 10 pages × 100 = the upstream offset ceiling.
  for (let page = 0; page < 10; page++) {
    const data = (await xrpc("searchPackages", { limit: "100", ...(cursor ? { cursor } : {}) }, fetcher)) as
      | { packages?: unknown[]; cursor?: string }
      | null;
    if (!data || !Array.isArray(data.packages)) break;
    for (const raw of data.packages) {
      const pkg = normalisePackage(raw);
      if (pkg) out.push(pkg);
    }
    cursor = str(data.cursor) ?? undefined;
    if (!cursor) break;
  }
  return out;
}

export async function getRegistryPackage(
  handle: string,
  slug: string,
  fetcher: Fetcher = fetch,
): Promise<RegistryPackage | null> {
  return normalisePackage(await xrpc("resolvePackage", { handle, slug }, fetcher));
}

export async function getLatestRegistryRelease(
  pkg: Pick<RegistryPackage, "did" | "slug">,
  fetcher: Fetcher = fetch,
): Promise<RegistryRelease | null> {
  return normaliseRelease(await xrpc("getLatestRelease", { did: pkg.did, package: pkg.slug }, fetcher));
}
