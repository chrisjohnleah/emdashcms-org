import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  insertSample,
  enforceRetention,
  getRecent7Days,
  computeUptimePercent,
  classifyCurrent,
  buildHistogramBuckets,
  type StatusSampleRow,
} from "../../../src/lib/status/status-queries";
import type { ProbeSample } from "../../../src/lib/status/probe";

async function clearTable() {
  await env.DB.exec("DELETE FROM status_samples");
}

function makeRow(
  surface: string,
  sampledAt: string,
  status: StatusSampleRow["status"] = "ok",
): StatusSampleRow {
  return {
    id: `row-${surface}-${sampledAt}`,
    surface,
    sampled_at: sampledAt,
    status,
    http_status: 200,
    latency_ms: 50,
  };
}

describe("insertSample", () => {
  beforeEach(clearTable);

  it("inserts a row with a generated UUID", async () => {
    const sample: ProbeSample = {
      surface: "landing",
      sampledAt: "2026-04-12T00:00:00Z",
      status: "ok",
      httpStatus: 200,
      latencyMs: 42,
    };
    await insertSample(env.DB, sample);
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM status_samples`)
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });
});

describe("enforceRetention", () => {
  beforeEach(clearTable);

  it("deletes rows strictly older than the cutoff and preserves recent rows", async () => {
    const now = new Date("2026-04-12T12:00:00Z");
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString();
    const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60_000).toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind("old-1", "landing", eightDaysAgo, "ok", 200, 30),
      env.DB
        .prepare(
          `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind("recent-1", "landing", sixDaysAgo, "ok", 200, 30),
    ]);
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
    const deleted = await enforceRetention(env.DB, cutoff);
    expect(deleted).toBe(1);
    const remaining = await env.DB
      .prepare(`SELECT id FROM status_samples`)
      .all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual(["recent-1"]);
  });
});

describe("getRecent7Days", () => {
  beforeEach(clearTable);

  it("returns only samples within 7 days for the requested surface", async () => {
    const now = new Date("2026-04-12T12:00:00Z");
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60_000).toISOString();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind("a", "landing", oneDayAgo, "ok", 200, 30),
      env.DB
        .prepare(
          `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind("b", "landing", eightDaysAgo, "ok", 200, 30),
      env.DB
        .prepare(
          `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind("c", "plugins_list", oneDayAgo, "ok", 200, 30),
    ]);
    const rows = await getRecent7Days(env.DB, "landing", now);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("computeUptimePercent", () => {
  it("returns 75.00 for [ok, ok, ok, slow]", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "ok"),
      makeRow("x", "t3", "ok"),
      makeRow("x", "t4", "slow"),
    ];
    expect(computeUptimePercent(samples)).toBe(75);
  });

  it("returns 100 for all ok", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "ok"),
      makeRow("x", "t3", "ok"),
      makeRow("x", "t4", "ok"),
    ];
    expect(computeUptimePercent(samples)).toBe(100);
  });

  it("returns null for empty input", () => {
    expect(computeUptimePercent([])).toBeNull();
  });

  it("rounds to 2 decimal places", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "ok"),
      makeRow("x", "t3", "fail"),
    ];
    expect(computeUptimePercent(samples)).toBe(66.67);
  });
});

describe("classifyCurrent", () => {
  it("returns 'ok' when last 3 are all ok", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "ok"),
      makeRow("x", "t3", "ok"),
    ];
    expect(classifyCurrent(samples)).toBe("ok");
  });

  it("returns 'degraded' when last 3 contain a slow but no fail/timeout", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "slow"),
      makeRow("x", "t3", "ok"),
    ];
    expect(classifyCurrent(samples)).toBe("degraded");
  });

  it("returns 'outage' when last 3 contain a fail", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "ok"),
      makeRow("x", "t3", "fail"),
    ];
    expect(classifyCurrent(samples)).toBe("outage");
  });

  it("returns 'outage' when last 3 contain a timeout", () => {
    const samples = [
      makeRow("x", "t1", "ok"),
      makeRow("x", "t2", "timeout"),
      makeRow("x", "t3", "ok"),
    ];
    expect(classifyCurrent(samples)).toBe("outage");
  });
});

describe("buildHistogramBuckets", () => {
  it("returns exactly 84 buckets at default 2-hour width covering 168 hours", () => {
    // Anchor `now` to a known top-of-hour for determinism.
    const now = new Date(Date.UTC(2026, 3, 12, 12, 30, 0));
    // Seed one sample per hour for 168 hours ending just before now.
    const samples: StatusSampleRow[] = [];
    for (let i = 0; i < 168; i++) {
      const t = new Date(Date.UTC(2026, 3, 12, 12, 0, 0) - (i + 1) * 60 * 60_000)
        .toISOString();
      samples.push(makeRow("x", t, "ok"));
    }
    const buckets = buildHistogramBuckets(samples, now);
    expect(buckets.length).toBe(84);
    const oldestStart = new Date(buckets[0].bucketStart).getTime();
    const expectedOldest = Date.UTC(2026, 3, 12, 12, 0, 0) - 168 * 60 * 60_000;
    expect(oldestStart).toBe(expectedOldest);
  });

  it("each default bucket spans exactly 2h (7,200,000 ms)", () => {
    const now = new Date(Date.UTC(2026, 3, 12, 12, 30, 0));
    const buckets = buildHistogramBuckets([], now);
    for (const b of buckets) {
      const span = new Date(b.bucketEnd).getTime() - new Date(b.bucketStart).getTime();
      expect(span).toBe(2 * 60 * 60_000);
    }
  });

  it("yields 'missing' for buckets with no samples", () => {
    const now = new Date(Date.UTC(2026, 3, 12, 12, 0, 0));
    const buckets = buildHistogramBuckets([], now);
    expect(buckets.every((b) => b.worstStatus === "missing")).toBe(true);
  });

  it("worst-wins resolution: fail > timeout > slow > ok within a bucket", () => {
    const now = new Date(Date.UTC(2026, 3, 12, 12, 0, 0));
    // All four samples in the most recent bucket [10:00, 12:00)
    const samples: StatusSampleRow[] = [
      makeRow("x", "2026-04-12T10:05:00Z", "ok"),
      makeRow("x", "2026-04-12T10:30:00Z", "slow"),
      makeRow("x", "2026-04-12T11:00:00Z", "timeout"),
      makeRow("x", "2026-04-12T11:30:00Z", "fail"),
    ];
    const buckets = buildHistogramBuckets(samples, now);
    const newest = buckets[buckets.length - 1];
    expect(newest.worstStatus).toBe("fail");
  });

  it("with bucketWidthHours=1 the bucket count is still 84", () => {
    const now = new Date(Date.UTC(2026, 3, 12, 12, 30, 0));
    const buckets = buildHistogramBuckets([], now, 1);
    expect(buckets.length).toBe(84);
  });
});
