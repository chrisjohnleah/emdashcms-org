// Test-only worker entry point
// Provides the same queue handler as src/worker.ts but a simple fetch handler
// that doesn't depend on Astro's virtual modules (unavailable in test context)

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
    _env: Env,
    _ctx: ExecutionContext,
  ) {
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
