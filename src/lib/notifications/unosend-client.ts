/**
 * Unosend transactional email client.
 *
 * A single stateless helper around `POST https://api.unosend.co/emails`
 * that returns the parsed response or throws a typed error. Mirrors the
 * raw-fetch style of src/lib/auth/github.ts — no SDK lock-in, fully
 * testable via `vi.stubGlobal('fetch', ...)`.
 *
 * Docs:
 *  - https://docs.unosend.co/api-reference/emails/send-email.md
 *  - https://docs.unosend.co/resources/error-codes.md
 *
 * Error classification:
 *  - 429, 5xx, or a known transient error `code` → UnosendTransientError
 *    (caller should retry via Cloudflare Queues backoff)
 *  - 4xx with a non-transient code → UnosendPermanentError (do not retry)
 *
 * CRITICAL (T-01 in 12-01-PLAN.md threat model): NEVER log `params.apiKey`.
 * On error paths, only the response error envelope (`{code, status, message}`)
 * is logged — never the request body or headers.
 */

export class UnosendTransientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "UnosendTransientError";
  }
}

export class UnosendPermanentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "UnosendPermanentError";
  }
}

export interface UnosendSendParams {
  /** `env.UNOSEND_API_KEY` — never hard-coded, never logged. */
  apiKey: string;
  /** `"EmDash Notifications <notifications@emdashcms.org>"` (caller-provided). */
  from: string;
  /** Single recipient — multi-recipient is explicitly deferred in CONTEXT.md. */
  to: string;
  /** `"no-reply@emdashcms.org"` by convention. */
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Provider-side categorisation — useful for dashboard filtering. */
  tags?: { name: string; value: string }[];
  /** Diagnostic headers only (e.g. idempotency key copy). */
  headers?: Record<string, string>;
}

export interface UnosendSendResponse {
  /** Provider id — `eml_xxxxxxxx` — stored as `notification_deliveries.provider_id`. */
  id: string;
  status: "queued";
}

/**
 * Error codes that indicate a transient failure and should be retried.
 * Sources:
 *  - https://docs.unosend.co/resources/error-codes.md
 *  - Open Question 2 in 12-RESEARCH.md (insufficient_quota treated transient)
 */
const TRANSIENT_CODES = new Set<string>([
  "rate_limit_exceeded", // 429
  "daily_limit_exceeded", // 429
  "quota_exceeded", // 429
  "insufficient_quota", // 429
  "internal_server_error", // 500
  "service_unavailable", // 503
  "gateway_timeout", // 504
  "email_delivery_failed", // 500
]);

interface UnosendErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
  };
}

/**
 * Send a transactional email through Unosend.
 *
 * Returns the parsed response with the provider id on success, throws
 * `UnosendTransientError` for retryable failures and `UnosendPermanentError`
 * for everything else.
 */
export async function sendTransactional(
  params: UnosendSendParams,
): Promise<UnosendSendResponse> {
  const response = await fetch("https://api.unosend.co/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      reply_to: params.replyTo,
      subject: params.subject,
      html: params.html,
      text: params.text,
      tags: params.tags,
      headers: params.headers,
      // Transactional priority per Unosend docs.
      priority: "high",
      // Privacy: publisher emails don't carry open/click tracking pixels.
      tracking: { open: false, click: false },
    }),
  });

  if (response.ok) {
    return (await response.json()) as UnosendSendResponse;
  }

  const body = (await response
    .json()
    .catch(() => ({}))) as UnosendErrorEnvelope;
  const code = body.error?.code ?? "unknown_error";
  const message =
    body.error?.message ?? `Unosend returned HTTP ${response.status}`;

  // Log only the error envelope — NEVER the request body or Authorization
  // header. See T-01 in 12-01-PLAN.md.
  console.error(
    `[unosend] Send failed: code=${code} status=${response.status} message=${message}`,
  );

  if (TRANSIENT_CODES.has(code) || response.status >= 500) {
    throw new UnosendTransientError(message, code, response.status);
  }
  throw new UnosendPermanentError(message, code, response.status);
}
