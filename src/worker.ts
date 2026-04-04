// Custom Cloudflare Worker entry point
// - fetch: delegates to Astro's handler for SSR pages + API endpoints
// - queue: processes audit jobs (skeleton in Phase 1, implemented in Phase 5)
import { handle } from "@astrojs/cloudflare/handler";

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },

  async queue(batch, _env, _ctx) {
    for (const message of batch.messages) {
      try {
        console.log(
          `[audit-queue] Received job: ${JSON.stringify(message.body)}`,
        );
        message.ack();
      } catch (err) {
        console.error(
          `[audit-queue] Failed to process message ${message.id}:`,
          err,
        );
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
