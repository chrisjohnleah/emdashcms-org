/**
 * Phase 15 end-to-end anonymization guard.
 *
 * LOCKED APPROACH: calls the pure render functions directly so the test
 * runs in workerd without any Astro router stand-in. Plan 1 already
 * guarantees the row itself contains zero IDENTIFYING_TOKENS; this test
 * is the page-layer floor — a future template edit that tries to
 * surface "Reported by X" or "Plugin: Y" on any Phase 15 page would
 * still fail these assertions because the pure renderer is the single
 * source of truth both the page and this test consume.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  seedTransparencyFixture,
  IDENTIFYING_TOKENS,
} from "../fixtures/transparency-seed";
import { runWeeklyTransparency } from "../../src/lib/transparency/cron-handler";
import {
  getLatestWeek,
  listWeeks,
} from "../../src/lib/transparency/transparency-queries";
import { renderTransparencyHtml } from "../../src/lib/transparency/render";
import {
  getAllSurfaces7Days,
  insertSample,
} from "../../src/lib/status/status-queries";
import { ALL_SURFACES } from "../../src/lib/status/probe";
import {
  buildSurfaceView,
  renderStatusStrip,
} from "../../src/lib/status/render";

describe("Phase 15 end-to-end anonymization guard", () => {
  beforeEach(async () => {
    await env.DB.exec(
      "DELETE FROM transparency_weeks; DELETE FROM status_samples; DELETE FROM plugin_audits; DELETE FROM plugin_versions; DELETE FROM reports; DELETE FROM audit_budget; DELETE FROM plugins; DELETE FROM authors;",
    );
    await seedTransparencyFixture(env.DB);
    await runWeeklyTransparency(env);
  });

  it("transparency_weeks row contains zero identifying tokens", async () => {
    const rows = await env.DB.prepare(
      "SELECT * FROM transparency_weeks",
    ).all();
    const serialized = JSON.stringify(rows.results);
    for (const token of IDENTIFYING_TOKENS) {
      expect(serialized).not.toContain(token);
    }
  });

  it("renderTransparencyHtml output contains zero identifying tokens", async () => {
    const row = await getLatestWeek(env.DB);
    expect(row).not.toBeNull();
    const html = renderTransparencyHtml(row!);
    for (const token of IDENTIFYING_TOKENS) {
      expect(html).not.toContain(token);
    }
  });

  it("listWeeks output contains zero identifying tokens", async () => {
    const rows = await listWeeks(env.DB);
    const serialized = JSON.stringify(rows);
    for (const token of IDENTIFYING_TOKENS) {
      expect(serialized).not.toContain(token);
    }
  });

  it("renderStatusStrip output contains zero identifying tokens AND has correct shape", async () => {
    // Seed one sample per surface so every SurfaceView is populated.
    // Status samples never carry entity tokens by construction — this
    // assertion is the floor that catches a future regression where
    // someone accidentally wires plugin metadata through a SurfaceView
    // field.
    const now = new Date();
    for (const surface of ALL_SURFACES) {
      await insertSample(env.DB, {
        surface: surface.name,
        sampledAt: now.toISOString(),
        status: "ok",
        httpStatus: 200,
        latencyMs: 120,
      });
    }
    const samplesBySurface = await getAllSurfaces7Days(env.DB);
    const surfaceViews = ALL_SURFACES.map((s) =>
      buildSurfaceView(
        s.name,
        s.label,
        "",
        samplesBySurface.get(s.name) ?? [],
        now,
      ),
    );
    const html = renderStatusStrip(surfaceViews);

    // Anonymization assertion.
    for (const token of IDENTIFYING_TOKENS) {
      expect(html).not.toContain(token);
    }

    // Bar count sanity: 5 surfaces × 84 buckets = 420 <rect> elements.
    const rectMatches = html.match(/<rect/g) ?? [];
    expect(rectMatches.length).toBe(5 * 84);

    // Tooltip format sanity: corrected D-29 math (2h buckets, not 1h).
    expect(html).toContain("2h ending ");
  });
});
