import { describe, it, expect, vi } from "vitest";
import {
  ALL_SURFACES,
  probeSurface,
  type Surface,
} from "../../../src/lib/status/probe";

const LANDING: Surface = ALL_SURFACES.find((s) => s.name === "landing")!;
const BUNDLE: Surface = ALL_SURFACES.find((s) => s.name === "bundle")!;

function makeFetchMock(impl: (url: string) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request) =>
    impl(typeof url === "string" ? url : url.toString())) as unknown as typeof fetch;
}

describe("probeSurface", () => {
  it("classifies a fast 200 as ok", async () => {
    const fetchMock = makeFetchMock(async () => new Response("", { status: 200 }));
    const sample = await probeSurface(fetchMock, LANDING, "https://example.test/");
    expect(sample.status).toBe("ok");
    expect(sample.httpStatus).toBe(200);
    expect(typeof sample.latencyMs).toBe("number");
  });

  it("classifies a 500 as fail", async () => {
    const fetchMock = makeFetchMock(async () => new Response("", { status: 500 }));
    const sample = await probeSurface(fetchMock, LANDING, "https://example.test/");
    expect(sample.status).toBe("fail");
    expect(sample.httpStatus).toBe(500);
  });

  it("classifies a 404 as fail", async () => {
    const fetchMock = makeFetchMock(async () => new Response("", { status: 404 }));
    const sample = await probeSurface(fetchMock, LANDING, "https://example.test/");
    expect(sample.status).toBe("fail");
    expect(sample.httpStatus).toBe(404);
  });

  it("classifies a slow but successful response as slow", async () => {
    // Use fake timers so we can simulate a 2.5s response without waiting.
    vi.useFakeTimers();
    try {
      const fetchMock = makeFetchMock(async () => {
        // Advance past the 2000ms slow threshold but not past TIMEOUT_MS=5000.
        await vi.advanceTimersByTimeAsync(2500);
        return new Response("", { status: 200 });
      });
      const sample = await probeSurface(
        fetchMock,
        LANDING,
        "https://example.test/",
      );
      expect(sample.status).toBe("slow");
      expect(sample.httpStatus).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies an AbortError as timeout", async () => {
    const fetchMock = makeFetchMock(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const sample = await probeSurface(fetchMock, LANDING, "https://example.test/");
    expect(sample.status).toBe("timeout");
    expect(sample.httpStatus).toBeNull();
    expect(sample.latencyMs).toBeNull();
  });

  it("classifies a TypeError (network failure) as fail", async () => {
    const fetchMock = makeFetchMock(async () => {
      throw new TypeError("fetch failed");
    });
    const sample = await probeSurface(fetchMock, LANDING, "https://example.test/");
    expect(sample.status).toBe("fail");
    expect(sample.httpStatus).toBeNull();
    expect(sample.latencyMs).toBeNull();
  });

  it("treats a 302 redirect on the bundle surface as ok (ceiling=399)", async () => {
    const fetchMock = makeFetchMock(
      async () => new Response("", { status: 302 }),
    );
    const sample = await probeSurface(
      fetchMock,
      BUNDLE,
      "https://example.test/api/v1/plugins/canary/versions/0.1.0/bundle",
    );
    expect(sample.status).toBe("ok");
    expect(sample.httpStatus).toBe(302);
  });
});
