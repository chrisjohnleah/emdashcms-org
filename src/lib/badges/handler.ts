/**
 * Extracted badge route handler.
 *
 * Why this lives in a library file rather than inlined in the Astro
 * route: `test/worker-test-entry.ts` is a stub fetch handler that does
 * not exercise the Astro router, so `SELF.fetch("/badges/...")` would
 * never reach the real route. Integration tests import
 * `handleBadgeRequest` directly and pass a constructed Request + a
 * mock env. The Astro shim (`src/pages/badges/v1/plugin/[id]/[metric].svg.ts`)
 * is a two-line wrapper around this function.
 *
 * Flow:
 *   1. Per-IP rate limit via `env.GENERAL_RATE_LIMITER` (BADG-05).
 *      Badge routes live outside `/api/` so the middleware's limiter
 *      never fires — we call the binding directly here.
 *   2. Parse the URL for plugin id + metric name (D-01 URL pattern).
 *   3. Validate metric. Unknown metric = 400 + `Cache-Control: no-store`.
 *   4. Build a pathname-only cache key so query strings can't poison
 *      the edge cache (T-13-03).
 *   5. `caches.default.match` — HIT path sets `CF-Cache-Status: HIT`
 *      manually (Pitfall 1 — the Cache API never sets this header).
 *   6. Cache miss: one D1 read via `getBadgeData`, render the SVG,
 *      set `CF-Cache-Status: MISS`, write to cache (best-effort).
 *
 * No cookie reads, no session checks — D-17 anonymous access.
 */

import {
  BADGE_METRICS,
  buildBadgeContent,
  getBadgeData,
  type BadgeMetric,
} from "./metrics";
import { BADGE_COLORS, renderBadge, xmlEscape } from "./render";

/**
 * `caches.default` is a Cloudflare Workers runtime global. The DOM lib
 * bundled with TypeScript's default target also declares `CacheStorage`
 * but without `default`, and `astro check` picks the DOM shape before
 * the workerd shape from `worker-configuration.d.ts`. Narrow-cast here
 * once so the rest of the file stays clean.
 */
const defaultCache: Cache = (caches as unknown as { default: Cache }).default;

/**
 * D-10 cache header. Browsers cache for 5 minutes; the edge caches for
 * 1 hour; stale-while-revalidate smooths refresh for a day.
 */
const CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

const BADGE_PATH_PATTERN =
  /^\/badges\/v1\/plugin\/([^/]+)\/([^/]+)\.svg$/;

/**
 * Main entry point. Returns a `Response` — never throws. Callers
 * (either the Astro shim or a test harness) should return whatever
 * this returns verbatim.
 */
export async function handleBadgeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // 1. Rate limit first. Per-IP, counter lives at the edge, no D1.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await env.GENERAL_RATE_LIMITER.limit({ key: ip });
  if (!rl.success) {
    return new Response("rate limited", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // 2. Parse path. `decodeURIComponent` handles `%40scope%2Fname`.
  const url = new URL(request.url);
  const match = url.pathname.match(BADGE_PATH_PATTERN);
  if (!match) {
    return badMetricResponse("bad path");
  }
  const pluginId = decodeURIComponent(match[1]);
  const metricRaw = match[2];

  // 3. Validate metric name. Unknown = 400 + no-store.
  if (!(BADGE_METRICS as readonly string[]).includes(metricRaw)) {
    return badMetricResponse("bad metric");
  }
  const metric = metricRaw as BadgeMetric;

  // 4. Cache key is derived from pathname only (T-13-03 — prevent
  //    query-string cache poisoning). Build a synthetic GET Request
  //    whose URL is origin + pathname, dropping any `?...` junk.
  const cacheKey = new Request(`${url.origin}${url.pathname}`, {
    method: "GET",
  });

  const cached = await defaultCache.match(cacheKey);
  if (cached) {
    // Cache API never sets CF-Cache-Status. Clone headers via the
    // Response copy ctor and mutate before returning.
    const hit = new Response(cached.body, cached);
    hit.headers.set("CF-Cache-Status", "HIT");
    return hit;
  }

  // 5. Cache miss — exactly one D1 read.
  const data = await getBadgeData(env.DB, pluginId);
  const content = buildBadgeContent(metric, data);
  const svg = renderBadge(content.label, content.value, content.color);

  const response = new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": CACHE_CONTROL,
      "CF-Cache-Status": "MISS",
    },
  });

  // 6. Populate cache (best-effort — never fail the request).
  try {
    await defaultCache.put(cacheKey, response.clone());
  } catch (err) {
    console.error("[badges] cache.put failed:", err);
  }

  return response;
}

/**
 * Tiny "bad metric" / "bad path" SVG. Returned as 400 with
 * `Cache-Control: no-store` so typo-flooding cannot cache-pollute the
 * edge. Rendered large enough to be visible inside a README without
 * showing a broken-image glyph.
 */
function badMetricResponse(reason: string): Response {
  const safeReason = xmlEscape(reason);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" role="img" aria-label="badge: ${safeReason}">` +
    `<title>badge: ${safeReason}</title>` +
    `<rect width="120" height="20" rx="3" fill="${BADGE_COLORS.muted}"/>` +
    `<text x="60" y="14" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" fill="#fff">${safeReason}</text>` +
    `</svg>`;
  return new Response(svg, {
    status: 400,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
