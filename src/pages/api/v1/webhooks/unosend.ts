/**
 * Unosend webhook endpoint.
 *
 * Receives delivery status events from Unosend (bounces, complaints,
 * deliveries, etc.) with HMAC-SHA256 signatures. Hard bounces flip the
 * `authors.email_bounced_at` flag so the dashboard banner surfaces the
 * broken-email state (D-22). Soft bounces are trusted to Unosend's own
 * retry behavior (D-23).
 *
 * Middleware: `/api/v1/webhooks/*` is exempted from CSRF and rate
 * limiting in `src/middleware.ts` — both lines 53 and 145. This endpoint
 * inherits the exemption automatically.
 *
 * The handler ALWAYS returns 200 once the signature validates. Schema
 * parse failures and downstream DB errors are logged but never bubble
 * up as 4xx/5xx responses, because Unosend would interpret a non-2xx as
 * a delivery failure and trigger a retry storm (Pitfall 2 in
 * 12-RESEARCH.md).
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyUnosendSignature } from "../../../../lib/notifications/bounce-webhook-verify";
import { unosendBounceEventSchema } from "../../../../lib/notifications/schemas";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Step 1: Read the raw body BEFORE JSON parsing — JSON.parse normalises
  // whitespace and key order which would invalidate the HMAC.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("X-Unosend-Signature");

  // Step 2: Pull the secret. The secret is declared in
  // wrangler.jsonc.secrets.required and must be set via
  // `wrangler secret put UNOSEND_WEBHOOK_SECRET` before this endpoint
  // can validate any incoming signature.
  const webhookSecret = (
    env as unknown as { UNOSEND_WEBHOOK_SECRET?: string }
  ).UNOSEND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[unosend-webhook] UNOSEND_WEBHOOK_SECRET not configured");
    return new Response(
      JSON.stringify({ error: "Webhook secret not configured" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Step 3: HMAC-SHA256 signature verification (timing-safe).
  const valid = await verifyUnosendSignature(
    rawBody,
    signatureHeader,
    webhookSecret,
  );
  if (!valid) {
    return new Response(
      JSON.stringify({ error: "Invalid signature" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Step 4: Parse the body. Any parse failure (malformed JSON, schema
  // mismatch) logs a hard error and STILL returns 200 — we never want a
  // bad event to make Unosend retry it.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch (err) {
    console.error("[unosend-webhook] JSON parse failed:", err);
    return new Response("OK", { status: 200 });
  }

  const parseResult = unosendBounceEventSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    console.error(
      "[unosend-webhook] schema parse failed:",
      parseResult.error,
    );
    return new Response("OK", { status: 200 });
  }
  const event = parseResult.data;

  // Step 5: Dispatch on event type. Hard bounces flip the author flag
  // and update the delivery row. Soft bounces, complaints, deliveries,
  // etc. are no-ops in Phase 12 — Phase 12 only cares about hard bounces.
  try {
    if (event.type === "email.bounced" && event.data.bounce_type === "hard") {
      // (a) Flip the author bounce flag so the dashboard banner surfaces it.
      await env.DB.prepare(
        `UPDATE authors
         SET email_bounced_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE email = ?`,
      )
        .bind(event.data.email)
        .run();

      // (b) If the event references a specific Unosend message id, mark
      //     the corresponding delivery row as bounced. The provider_id
      //     column is populated when markSent runs in the consumer.
      if (event.data.email_id) {
        await env.DB.prepare(
          `UPDATE notification_deliveries
           SET status = 'bounced',
               bounced_reason = ?,
               last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE provider_id = ?`,
        )
          .bind(event.data.bounce_reason ?? "hard bounce", event.data.email_id)
          .run();
      }
      console.log(
        `[unosend-webhook] hard bounce processed for email=${event.data.email}`,
      );
    } else if (
      event.type === "email.bounced" &&
      event.data.bounce_type === "soft"
    ) {
      // D-23: soft bounces are trusted to Unosend's own retry — no-op.
    } else {
      // Other event types (delivered, sent, complained, etc.) — Phase 12
      // doesn't act on them, just acknowledge.
      console.log(
        `[unosend-webhook] acknowledged event type=${event.type}`,
      );
    }
  } catch (err) {
    // Don't surface DB errors to Unosend as 5xx — that would trigger a
    // retry storm. Log loudly so the operator sees the failure.
    console.error("[unosend-webhook] handler error:", err);
  }

  return new Response("OK", { status: 200 });
};
