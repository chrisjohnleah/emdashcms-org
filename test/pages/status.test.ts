/**
 * Integration tests for /status.
 *
 * LOCKED APPROACH (per Plan 2 contract): tests the query layer and the
 * pure render functions directly — no Astro page module import. The
 * page's entire data path lives in `src/lib/status/*` so every contract
 * the page relies on is exercised here in workerd.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ALL_SURFACES } from "../../src/lib/status/probe";
import {
  insertSample,
  getAllSurfaces7Days,
  computeUptimePercent,
  classifyCurrent,
  buildHistogramBuckets,
  type StatusSampleRow,
} from "../../src/lib/status/status-queries";
import {
  buildSurfaceView,
  renderStatusStrip,
} from "../../src/lib/status/render";

async function resetSamples() {
  await env.DB.exec("DELETE FROM status_samples");
}

function sampleRow(overrides: Partial<StatusSampleRow> = {}): StatusSampleRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    surface: overrides.surface ?? "landing",
    sampled_at: overrides.sampled_at ?? new Date().toISOString(),
    status: overrides.status ?? "ok",
    http_status: overrides.http_status ?? 200,
    latency_ms: overrides.latency_ms ?? 120,
  };
}

describe("/status — empty state", () => {
  beforeEach(async () => {
    await resetSamples();
  });

  it("clean DB → empty map; every surface view has sampleCount 0 and classification 'unknown'", async () => {
    const map = await getAllSurfaces7Days(env.DB);
    expect(map.size).toBe(0);

    const views = ALL_SURFACES.map((s) =>
      buildSurfaceView(s.name, s.label, "", map.get(s.name) ?? []),
    );
    expect(views).toHaveLength(5);
    for (const v of views) {
      expect(v.sampleCount).toBe(0);
      expect(v.classification).toBe("unknown");
      expect(v.uptimePercent).toBeNull();
      expect(v.buckets).toHaveLength(84);
    }
  });
});

describe("/status — populated", () => {
  beforeEach(async () => {
    await resetSamples();
  });

  it("10 'ok' samples on landing → 100.00 uptime, 'ok' classification, 84 buckets", async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await insertSample(env.DB, {
        surface: "landing",
        sampledAt: new Date(now.getTime() - i * 60_000).toISOString(),
        status: "ok",
        httpStatus: 200,
        latencyMs: 120,
      });
    }
    const map = await getAllSurfaces7Days(env.DB);
    const landing = map.get("landing") ?? [];
    expect(landing).toHaveLength(10);

    expect(computeUptimePercent(landing)).toBe(100);
    expect(classifyCurrent(landing)).toBe("ok");
    expect(buildHistogramBuckets(landing, now, 2)).toHaveLength(84);
  });

  it("degraded classification when last 3 include a 'slow'", () => {
    const now = new Date();
    // sampled_at ASC ordering mirrors what the query produces.
    const samples: StatusSampleRow[] = [
      sampleRow({ status: "ok", sampled_at: new Date(now.getTime() - 3 * 60_000).toISOString() }),
      sampleRow({ status: "ok", sampled_at: new Date(now.getTime() - 2 * 60_000).toISOString() }),
      sampleRow({ status: "slow", sampled_at: new Date(now.getTime() - 60_000).toISOString() }),
    ];
    expect(classifyCurrent(samples)).toBe("degraded");
  });

  it("outage classification when last sample is 'fail'", () => {
    const now = new Date();
    const samples: StatusSampleRow[] = [
      sampleRow({ status: "ok", sampled_at: new Date(now.getTime() - 2 * 60_000).toISOString() }),
      sampleRow({ status: "ok", sampled_at: new Date(now.getTime() - 60_000).toISOString() }),
      sampleRow({ status: "fail", sampled_at: now.toISOString() }),
    ];
    expect(classifyCurrent(samples)).toBe("outage");
  });

  it("buildHistogramBuckets always returns exactly 84 entries and each bucket spans 2 hours", () => {
    const now = new Date();
    const buckets = buildHistogramBuckets([], now, 2);
    expect(buckets).toHaveLength(84);
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    for (const b of buckets) {
      const spanMs = new Date(b.bucketEnd).getTime() - new Date(b.bucketStart).getTime();
      expect(spanMs).toBe(TWO_HOURS_MS);
    }
  });

  it("84 buckets cover 168 hours — oldest bucket starts no earlier than 168h before the top-of-hour", () => {
    const now = new Date("2026-04-24T15:37:00Z");
    const buckets = buildHistogramBuckets([], now, 2);
    const topOfHour = new Date(now);
    topOfHour.setUTCMinutes(0, 0, 0);
    const oldestStart = new Date(buckets[0].bucketStart).getTime();
    const newestEnd = new Date(buckets[83].bucketEnd).getTime();
    expect(newestEnd).toBe(topOfHour.getTime());
    expect(topOfHour.getTime() - oldestStart).toBe(168 * 60 * 60 * 1000);
  });
});

describe("renderStatusStrip — rendered fragment contract", () => {
  it("emits exactly 5 × 84 = 420 <rect elements across five populated surface views", () => {
    const now = new Date();
    const views = ALL_SURFACES.map((s) =>
      buildSurfaceView(s.name, s.label, "GET /", [], now),
    );
    const html = renderStatusStrip(views);
    const rectMatches = html.match(/<rect/g) ?? [];
    expect(rectMatches.length).toBe(5 * 84);
  });

  it("includes the '2h ending ' tooltip substring (corrected D-29 math, not 1h)", () => {
    const now = new Date();
    const views = ALL_SURFACES.map((s) =>
      buildSurfaceView(s.name, s.label, "GET /", [], now),
    );
    const html = renderStatusStrip(views);
    expect(html).toContain("2h ending ");
    expect(html).not.toContain("1h ending ");
  });
});
