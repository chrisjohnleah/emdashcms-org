// Custom Cloudflare Worker entry point
// - fetch: delegates to Astro's handler for SSR pages + API endpoints
// - queue: processes audit jobs via the audit consumer pipeline
import { handle } from "@astrojs/cloudflare/handler";
import {
  processAuditJob,
  BudgetExceededError,
  TransientError,
} from "./lib/audit/consumer";
import { rejectVersion } from "./lib/audit/audit-queries";
import { cleanupOldRateLimits } from "./lib/downloads/rate-limit";
import type { AuditJob } from "./types/marketplace";

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },

  async scheduled(_event, env, _ctx) {
    // Purge rate_limits rows older than 1 hour to prevent unbounded growth.
    // Keys are `{ip}:{YYYY-MM-DDTHH:MM}` so the trailing 16 chars are the bucket.
    const cutoff = new Date(Date.now() - 60 * 60_000)
      .toISOString()
      .slice(0, 16);
    try {
      await cleanupOldRateLimits(env.DB, cutoff);
    } catch (err) {
      console.error("[scheduled] rate_limits cleanup failed:", err);
    }
  },

  async queue(batch, env, _ctx) {
    for (const message of batch.messages) {
      const job = message.body as AuditJob;
      try {
        await processAuditJob(job, {
          db: env.DB,
          ai: env.AI,
          artifacts: env.ARTIFACTS,
        });
        message.ack();
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.log(
            `[audit] Budget exceeded for plugin=${job.pluginId} version=${job.version}, retrying in 1 hour`,
          );
          message.retry({ delaySeconds: 3600 });
        } else if (err instanceof TransientError) {
          console.warn(
            `[audit] Transient error for plugin=${job.pluginId} version=${job.version}: ${err.message}`,
          );
          message.retry({ delaySeconds: 120 });
        } else {
          // Permanent failure: processAuditJob already rejected the version
          // for known permanent errors. If we reach here, it's unexpected.
          console.error(
            `[audit] Unexpected error for plugin=${job.pluginId} version=${job.version}:`,
            err,
          );
          // Reject version if not already rejected, then ack to prevent infinite retry
          try {
            const row = await env.DB.prepare(
              "SELECT id, status FROM plugin_versions WHERE plugin_id = ? AND version = ?",
            )
              .bind(job.pluginId, job.version)
              .first<{ id: string; status: string }>();
            if (row && row.status === "pending") {
              await rejectVersion(
                env.DB,
                row.id,
                `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          } catch (rejectErr) {
            console.error(
              "[audit] Failed to reject version after unexpected error:",
              rejectErr,
            );
          }
          message.ack();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;
