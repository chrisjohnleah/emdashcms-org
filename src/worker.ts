// Custom Cloudflare Worker entry point
// - fetch:     delegates to Astro's handler for SSR pages + API endpoints
// - scheduled: dispatches on `event.cron` — hourly rate_limits cleanup
//              (0 * * * *) and daily notification digest (5 9 * * *)
// - queue:     dispatches batches to the audit OR notifications consumer
//              based on `batch.queue` (parallel handler pattern, D-27)
import { handle } from "@astrojs/cloudflare/handler";
import {
  processAuditJob,
  BudgetExceededError,
  TransientError,
} from "./lib/audit/consumer";
import { rejectVersion } from "./lib/audit/audit-queries";
import { pollPendingBatches } from "./lib/audit/batch-poller";
import { processNotificationBatch } from "./lib/notifications/consumer";
import { runDailyDigest } from "./lib/notifications/digest";
import { cleanupOldRateLimits } from "./lib/downloads/rate-limit";
import type { AuditJob, NotificationJob } from "./types/marketplace";

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    // Hourly rate_limits cleanup. Purge rows older than 1 hour to keep
    // the table bounded. Keys are `{ip}:{YYYY-MM-DDTHH:MM}` so the
    // trailing 16 chars are the bucket.
    if (event.cron === "0 * * * *") {
      const cutoff = new Date(Date.now() - 60 * 60_000)
        .toISOString()
        .slice(0, 16);
      try {
        await cleanupOldRateLimits(env.DB, cutoff);
      } catch (err) {
        console.error("[scheduled] rate_limits cleanup failed:", err);
      }
      return;
    }

    // Daily notification digest at 09:05 UTC (D-09 in 12-CONTEXT.md).
    // `waitUntil` lets the invocation acknowledge quickly while the
    // digest work continues in the background.
    if (event.cron === "5 9 * * *") {
      ctx.waitUntil(runDailyDigest(env));
      return;
    }

    // Workers AI Async Batch API poller. Runs every 2 minutes. Fetches
    // every `status='pending'` audit row with a `batch_request_id`,
    // polls Cloudflare for the result, and finalises the row via
    // completeBatchAudit or failBatchAudit. See src/lib/audit/batch-poller.ts
    // for the full lifecycle. `waitUntil` lets the cron tick ack fast
    // while polling continues in the background.
    if (event.cron === "*/2 * * * *") {
      ctx.waitUntil(
        pollPendingBatches({
          db: env.DB,
          ai: env.AI,
          notifQueue: env.NOTIF_QUEUE,
        }).catch((err) => {
          console.error("[scheduled] batch poller failed:", err);
        }),
      );
      return;
    }

    console.error(
      `[scheduled] Unknown cron expression: ${event.cron}`,
    );
  },

  async queue(batch, env, _ctx) {
    // Dispatch on the originating queue name. Both queues share this
    // single handler so we don't need a second worker entry point (D-27).
    if (batch.queue === "emdashcms-notifications") {
      await processNotificationBatch(
        batch as unknown as Parameters<typeof processNotificationBatch>[0],
        {
          db: env.DB,
          unosendApiKey: env.UNOSEND_API_KEY,
        },
      );
      return;
    }

    if (batch.queue !== "emdashcms-audit") {
      console.error(
        `[queue] Unknown queue '${batch.queue}' — acking ${batch.messages.length} message(s)`,
      );
      for (const message of batch.messages) message.ack();
      return;
    }

    // AUDIT_MODE: 'static-first' | 'auto' | 'manual' | 'off' — see wrangler.jsonc.
    // Default remains 'manual' for now (shadow deploy of static-first);
    // the wrangler.jsonc var will flip to 'static-first' after smoke testing.
    const auditMode =
      (env.AUDIT_MODE as
        | "manual"
        | "auto"
        | "off"
        | "static-first"
        | undefined) ?? "manual";
    console.log(
      `[queue] Received ${batch.messages.length} audit message(s), global auditMode=${auditMode}`,
    );
    for (const message of batch.messages) {
      const job = message.body as AuditJob;
      console.log(
        `[queue] Processing audit job: plugin=${job.pluginId} version=${job.version} modeOverride=${job.auditModeOverride ?? "none"} modelOverride=${job.modelOverride ?? "none"} bundleKey=${job.bundleKey}`,
      );
      try {
        await processAuditJob(job, {
          db: env.DB,
          ai: env.AI,
          artifacts: env.ARTIFACTS,
          auditMode,
          notifQueue: env.NOTIF_QUEUE,
        });
        console.log(
          `[queue] Audit complete, acking: plugin=${job.pluginId} version=${job.version}`,
        );
        message.ack();
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          // Budget errors no longer thrown by processAuditJob — kept here as defensive fallback.
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

// Type-only re-export so the NotificationJob import is consumed in
// `tsc --noEmit` strict mode.
export type _NotificationJobRef = NotificationJob;
