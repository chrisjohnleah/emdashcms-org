/**
 * TRNS-05 anonymization guard.
 *
 * Seeds the fixture so every IDENTIFYING_TOKENS entry exists in real
 * entity tables. Then runs the weekly aggregation pipeline and asserts:
 *   1. No identifier token appears in any column of any transparency_weeks row.
 *   2. No identifier token appears in the renderTransparencyHtml() output.
 *
 * The whole point of TRNS-05 is that we can stake this claim
 * programmatically — see 15-CONTEXT D-10/D-13/D-45.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  IDENTIFYING_TOKENS,
  seedTransparencyFixture,
} from "../../fixtures/transparency-seed";
import { runWeeklyTransparency } from "../../../src/lib/transparency/cron-handler";
import { renderTransparencyHtml } from "../../../src/lib/transparency/render";
import { getLatestWeek } from "../../../src/lib/transparency/transparency-queries";

async function clearTables() {
  await env.DB.exec(
    "DELETE FROM transparency_weeks; DELETE FROM plugin_audits; DELETE FROM plugin_versions; DELETE FROM reports; DELETE FROM audit_budget; DELETE FROM plugins; DELETE FROM authors;",
  );
}

describe("anonymization", () => {
  beforeEach(async () => {
    await clearTables();
    await seedTransparencyFixture(env.DB);
  });

  it("transparency_weeks rows contain no identifying tokens in any column", async () => {
    await runWeeklyTransparency(env);
    const result = await env.DB
      .prepare(`SELECT * FROM transparency_weeks`)
      .all<Record<string, unknown>>();
    expect(result.results.length).toBeGreaterThan(0);

    for (const row of result.results) {
      for (const value of Object.values(row)) {
        const asString = value === null ? "" : String(value);
        for (const token of IDENTIFYING_TOKENS) {
          expect(
            asString.includes(token),
            `transparency_weeks column value contained ${token}: ${asString}`,
          ).toBe(false);
        }
      }
    }
  });

  it("renderTransparencyHtml output contains zero identifying tokens", async () => {
    await runWeeklyTransparency(env);
    const row = await getLatestWeek(env.DB);
    expect(row).not.toBeNull();
    const html = renderTransparencyHtml(row!);
    for (const token of IDENTIFYING_TOKENS) {
      expect(html.includes(token), `rendered HTML contained ${token}`).toBe(
        false,
      );
    }
  });
});
