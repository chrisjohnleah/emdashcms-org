/**
 * Queue plumbing for deferred OG image generation.
 *
 * The request-path routes (src/pages/og/plugin/[id].png.ts and
 * src/pages/og/theme/[id].png.ts) call `enqueueOgJob` on an R2 miss
 * and return a placeholder PNG immediately. The OG_QUEUE consumer
 * (dispatched from src/worker.ts) calls `handleOgJob` to actually
 * render the image via `renderPluginOgImage` / `renderThemeOgImage`
 * and writes it to R2 keyed by `ogCacheKey(job)`.
 *
 * This split is load-bearing: `workers-og` generation is 200-500ms
 * CPU cold, which is 20-50x the 10ms Free-tier request-path ceiling.
 * The queue consumer runs inside the 90s CPU budget declared in
 * `wrangler.jsonc`.
 */

import { env } from 'cloudflare:workers';
import { getPluginDetail, getThemeDetail } from '../db/queries';
import {
  renderPluginOgImage,
  renderThemeOgImage,
} from './og-image';

/**
 * Discriminated union of OG jobs the consumer handles. Each variant
 * carries the exact inputs needed to (a) compute the R2 cache key
 * without a second D1 lookup and (b) re-fetch the current detail row
 * inside the consumer for rendering.
 *
 * Plugin jobs pin to a specific `version` so a republish produces a
 * new R2 key (and therefore a fresh OG image) automatically. Theme
 * jobs pin to the `updatedAtEpoch` (seconds since epoch) of the
 * theme row at the time the job was enqueued — same invalidation
 * mechanism, keyed on the only available "version" signal for
 * themes.
 */
export type OgJob =
  | { kind: 'plugin'; id: string; version: string }
  | { kind: 'theme'; id: string; updatedAtEpoch: number };

/**
 * Build the R2 key for an OG job. Immutable: version/epoch is baked
 * into the key, so once we've written an image there it will never
 * be overwritten for that (plugin, version) or (theme, updatedAt)
 * tuple.
 *
 * The `og/` prefix namespaces these inside the shared `ARTIFACTS`
 * bucket alongside the existing `bundles/` prefix used by the plugin
 * download pipeline.
 */
export function ogCacheKey(job: OgJob): string {
  return job.kind === 'plugin'
    ? `og/plugin/${job.id}/${job.version}.png`
    : `og/theme/${job.id}/${job.updatedAtEpoch}.png`;
}

/**
 * Enqueue an OG render job. Callers are the two request-path routes
 * (on cache miss) and, in principle, an admin backfill script.
 *
 * This function is intentionally tiny — the wrapper exists so the
 * request routes can stub the enqueue at the `enqueueOgJob` boundary
 * in tests without mocking the full Queue binding surface.
 */
export async function enqueueOgJob(
  queue: Queue<OgJob>,
  job: OgJob,
): Promise<void> {
  await queue.send(job);
}

/**
 * Consumer handler for a single OG queue message. Called by the
 * dispatcher in `src/worker.ts` for every message on
 * `emdashcms-og`.
 *
 * Flow:
 *  1. Compute the cache key.
 *  2. HEAD R2 — if the object already exists (idempotency: another
 *     worker generated it between the enqueue and this pickup), ack
 *     and return.
 *  3. Load the current plugin/theme detail row from D1.
 *  4. Render the PNG via workers-og.
 *  5. PUT the bytes to R2 with `Content-Type: image/png`.
 *  6. Ack the message.
 *
 * Error handling mirrors the audit consumer (Phase 5):
 *  - Missing DB row → ack (the entity was deleted; retrying won't
 *    help).
 *  - Render or R2 error → retry (queue will escalate to the DLQ
 *    after `max_retries` attempts per the wrangler.jsonc config).
 */
export async function handleOgJob(message: Message<OgJob>): Promise<void> {
  const job = message.body;
  const key = ogCacheKey(job);

  // Idempotency check — another worker may have generated this
  // image already while this message was in flight.
  const existing = await env.ARTIFACTS.head(key);
  if (existing) {
    console.log(`[og] skip already-generated ${key}`);
    message.ack();
    return;
  }

  try {
    let bytes: Uint8Array;
    if (job.kind === 'plugin') {
      const plugin = await getPluginDetail(env.DB, job.id);
      if (!plugin) {
        console.warn(
          `[og] plugin ${job.id} not found — skipping generation`,
        );
        message.ack();
        return;
      }
      bytes = await renderPluginOgImage(plugin);
    } else {
      const theme = await getThemeDetail(env.DB, job.id);
      if (!theme) {
        console.warn(
          `[og] theme ${job.id} not found — skipping generation`,
        );
        message.ack();
        return;
      }
      bytes = await renderThemeOgImage(theme);
    }

    await env.ARTIFACTS.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
    });
    console.log(`[og] wrote ${key} (${bytes.byteLength} bytes)`);
    message.ack();
  } catch (err) {
    console.error(`[og] generation failed for ${key}:`, err);
    // Do NOT ack — let the queue retry up to `max_retries` before
    // the message drops to `emdashcms-og-dlq`. The next retry gets a
    // fresh isolate, which also resets the workers-og wasm state if
    // the previous attempt was bitten by an upstream init bug.
    message.retry();
  }
}
