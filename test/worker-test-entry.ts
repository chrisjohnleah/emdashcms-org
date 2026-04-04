// Test-only worker entry point
// Provides the same queue handler as src/worker.ts but a simple fetch handler
// that doesn't depend on Astro's virtual modules (unavailable in test context)

import {
  processAuditJob,
  BudgetExceededError,
  TransientError,
} from "../src/lib/audit/consumer";
import type { AuditJob } from "../src/types/marketplace";

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);
    return new Response(`test worker: ${url.pathname}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },

  async queue(
    batch: MessageBatch<Record<string, unknown>>,
    env: Env,
    _ctx: ExecutionContext,
  ) {
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
          message.retry({ delaySeconds: 3600 });
        } else if (err instanceof TransientError) {
          message.retry({ delaySeconds: 120 });
        } else {
          message.ack();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;
