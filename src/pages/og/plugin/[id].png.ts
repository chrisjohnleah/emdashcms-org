/**
 * GET /og/plugin/[id].png — social share image for a plugin detail page.
 *
 * This route is a thin R2 proxy. It does NOT generate images itself —
 * `workers-og` costs 200-500ms CPU cold, which is 20-50x the 10ms
 * Workers Free-tier request-path budget (see Plan 16-02 research
 * §Q1). All heavy work happens in the OG_QUEUE consumer.
 *
 * Flow:
 *  1. Look up the plugin in D1.
 *  2. Compute the immutable R2 key
 *     `og/plugin/{id}/{latestVersion}.png`.
 *  3. If the R2 object exists → stream its body with `immutable`
 *     cache headers. Hot path, <5ms.
 *  4. If it doesn't → enqueue an OG_QUEUE job and return the 68-byte
 *     placeholder PNG with a short cache. Social crawlers that see
 *     the placeholder and re-fetch after the queue consumer finishes
 *     will get the real image on the next crawl.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getPluginDetail } from '../../../lib/db/queries';
import { enqueueOgJob, ogCacheKey } from '../../../lib/seo/og-queue';
import { PLACEHOLDER_PNG } from '../../../lib/seo/og-image';

export const prerender = false;

// Cache headers pulled up here so the two successful branches stay
// symmetrical and a future refactor can't accidentally drift them.
const CACHE_HIT_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=31536000, immutable',
} as const;

const PLACEHOLDER_HEADERS = {
  'Content-Type': 'image/png',
  // Short TTL on the placeholder so social crawlers re-fetch and
  // pick up the real image once the queue consumer has written it.
  'Cache-Control': 'public, max-age=60',
} as const;

export const GET: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) return new Response('Not found', { status: 404 });

  const plugin = await getPluginDetail(env.DB, id);
  if (!plugin) return new Response('Not found', { status: 404 });

  // Plugins without a latest version (e.g. mid-publish) still need a
  // valid key — fall back to `0.0.0` so the key is well-formed and
  // the consumer's re-fetch gets the up-to-date row on retry.
  const version = plugin.latestVersion?.version ?? '0.0.0';
  const key = ogCacheKey({ kind: 'plugin', id, version });

  // Hot path: R2 cache hit. Stream the body so we never buffer the
  // PNG in Worker memory.
  const object = await env.ARTIFACTS.get(key);
  if (object) {
    return new Response(object.body, { headers: CACHE_HIT_HEADERS });
  }

  // Cold path: enqueue and serve placeholder. The enqueue is a
  // fire-and-hope — if the queue send fails (quota exceeded,
  // transient API error) we still return the placeholder so the
  // social preview renders something and the page never 500s over
  // OG metadata.
  try {
    await enqueueOgJob(env.OG_QUEUE, { kind: 'plugin', id, version });
  } catch (err) {
    console.error(
      `[og] enqueue failed for plugin ${id}@${version}:`,
      err,
    );
  }

  // Cast: Workers Response accepts Uint8Array at runtime, but the
  // ambient lib.dom type lacks it in the BodyInit union. Handing it
  // back as an ArrayBuffer slice is semantically identical.
  return new Response(PLACEHOLDER_PNG.buffer as ArrayBuffer, {
    headers: PLACEHOLDER_HEADERS,
  });
};
