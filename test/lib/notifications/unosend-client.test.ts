import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendTransactional,
  UnosendTransientError,
  UnosendPermanentError,
  type UnosendSendParams,
} from "../../../src/lib/notifications/unosend-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_PARAMS: UnosendSendParams = {
  apiKey: "un_test_key_12345",
  from: "EmDash Notifications <notifications@emdashcms.org>",
  to: "publisher@example.com",
  replyTo: "no-reply@emdashcms.org",
  subject: "[EmDash] audit fail: test-plugin 1.2.3",
  html: "<h1>Your plugin audit failed</h1>",
  text: "Your plugin audit failed",
};

function mockOk(id = "eml_abc123"): Response {
  return new Response(JSON.stringify({ id, status: "queued" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockError(
  status: number,
  code: string,
  message = "error",
): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("sendTransactional — request shape", () => {
  it("POSTs to https://api.unosend.co/emails", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk(),
    );
    await sendTransactional(BASE_PARAMS);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.unosend.co/emails",
      expect.anything(),
    );
  });

  it("uses POST method", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk(),
    );
    await sendTransactional(BASE_PARAMS);
    const init = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
  });

  it("sets Authorization: Bearer <apiKey>", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk(),
    );
    await sendTransactional(BASE_PARAMS);
    const init = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer un_test_key_12345");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("body has from, to[array], subject, html, text, priority, tracking", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk(),
    );
    await sendTransactional(BASE_PARAMS);
    const init = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("EmDash Notifications <notifications@emdashcms.org>");
    expect(body.to).toEqual(["publisher@example.com"]);
    expect(body.reply_to).toBe("no-reply@emdashcms.org");
    expect(body.subject).toBe("[EmDash] audit fail: test-plugin 1.2.3");
    expect(body.html).toBe("<h1>Your plugin audit failed</h1>");
    expect(body.text).toBe("Your plugin audit failed");
    expect(body.priority).toBe("high");
    expect(body.tracking).toEqual({ open: false, click: false });
  });

  it("passes optional tags and headers when provided", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk(),
    );
    await sendTransactional({
      ...BASE_PARAMS,
      tags: [{ name: "event_type", value: "audit_fail" }],
      headers: { "X-EmDash-Idempotency": "abc" },
    });
    const init = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.tags).toEqual([{ name: "event_type", value: "audit_fail" }]);
    expect(body.headers).toEqual({ "X-EmDash-Idempotency": "abc" });
  });

  it("omits reply_to when not provided", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk(),
    );
    await sendTransactional({ ...BASE_PARAMS, replyTo: undefined });
    const init = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.reply_to).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

describe("sendTransactional — response handling", () => {
  it("returns parsed response on 2xx", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockOk("eml_xyz"),
    );
    const result = await sendTransactional(BASE_PARAMS);
    expect(result).toEqual({ id: "eml_xyz", status: "queued" });
  });

  it("throws UnosendTransientError on 429 rate_limit_exceeded", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(429, "rate_limit_exceeded"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendTransientError,
    );
  });

  it("throws UnosendTransientError on 429 quota_exceeded", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(429, "quota_exceeded"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendTransientError,
    );
  });

  it("throws UnosendTransientError on insufficient_quota", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(429, "insufficient_quota"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendTransientError,
    );
  });

  it("throws UnosendTransientError on 500", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(500, "internal_server_error"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendTransientError,
    );
  });

  it("throws UnosendTransientError on 503", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(503, "service_unavailable"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendTransientError,
    );
  });

  it("throws UnosendPermanentError on 400 invalid_email_address", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(400, "invalid_email_address", "bad"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendPermanentError,
    );
  });

  it("throws UnosendPermanentError on 401", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(401, "unauthorized"),
    );
    await expect(sendTransactional(BASE_PARAMS)).rejects.toBeInstanceOf(
      UnosendPermanentError,
    );
  });

  it("transient/permanent errors carry code and status", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(429, "rate_limit_exceeded", "slow down"),
    );
    try {
      await sendTransactional(BASE_PARAMS);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnosendTransientError);
      expect((err as UnosendTransientError).code).toBe("rate_limit_exceeded");
      expect((err as UnosendTransientError).status).toBe(429);
      expect((err as UnosendTransientError).message).toBe("slow down");
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-leak guard
// ---------------------------------------------------------------------------

describe("sendTransactional — secret leak guard", () => {
  it("does NOT log the api key on error paths", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockError(500, "internal_server_error"),
    );
    await sendTransactional(BASE_PARAMS).catch(() => {});
    const allArgs = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(allArgs).not.toContain("un_test_key_12345");
  });
});
