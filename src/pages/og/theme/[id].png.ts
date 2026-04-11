/**
 * GET /og/theme/[id].png — social share image for a theme detail page.
 *
 * Mirror of /og/plugin/[id].png. Themes have no version concept, so
 * the cache key uses `Math.floor(Date.parse(theme.updatedAt) / 1000)`
 * as the immutability marker — a theme row update bumps the epoch,
 * the key changes, and the next fetch cache-misses into a fresh
 * generation.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getThemeDetail } from '../../../lib/db/queries';
import { enqueueOgJob, ogCacheKey } from '../../../lib/seo/og-queue';
import { PLACEHOLDER_PNG } from '../../../lib/seo/og-image';

export const prerender = false;

const CACHE_HIT_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=31536000, immutable',
} as const;

const PLACEHOLDER_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=60',
} as const;

/**
 * Convert an ISO 8601 timestamp to a seconds-since-epoch integer.
 * Defensive fallback of `0` for malformed timestamps (should not
 * happen given D1's `strftime` writes; guards only protect against
 * future schema drift).
 */
function toEpochSeconds(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.floor(t / 1000);
}

export const GET: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) return new Response('Not found', { status: 404 });

  const theme = await getThemeDetail(env.DB, id);
  if (!theme) return new Response('Not found', { status: 404 });

  const updatedAtEpoch = toEpochSeconds(theme.updatedAt);
  const key = ogCacheKey({ kind: 'theme', id, updatedAtEpoch });

  const object = await env.ARTIFACTS.get(key);
  if (object) {
    return new Response(object.body, { headers: CACHE_HIT_HEADERS });
  }

  try {
    await enqueueOgJob(env.OG_QUEUE, {
      kind: 'theme',
      id,
      updatedAtEpoch,
    });
  } catch (err) {
    console.error(
      `[og] enqueue failed for theme ${id}@${updatedAtEpoch}:`,
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
