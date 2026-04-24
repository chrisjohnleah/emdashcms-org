import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runWeeklyTransparency } from "../../../src/lib/transparency/cron-handler";

async function clearTables() {
  await env.DB.exec(
    "DELETE FROM transparency_weeks; DELETE FROM plugin_audits; DELETE FROM plugin_versions; DELETE FROM reports; DELETE FROM audit_budget; DELETE FROM plugins; DELETE FROM authors;",
  );
}

describe("runWeeklyTransparency", () => {
  beforeEach(async () => {
    await clearTables();
  });

  it("writes exactly one row to transparency_weeks", async () => {
    await runWeeklyTransparency(env);
    const result = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM transparency_weeks`)
      .first<{ c: number }>();
    expect(result?.c).toBe(1);
  });

  it("is idempotent — two runs in the same week leave one row", async () => {
    await runWeeklyTransparency(env);
    await runWeeklyTransparency(env);
    const result = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM transparency_weeks`)
      .first<{ c: number }>();
    expect(result?.c).toBe(1);
  });

  it("never throws when the inner DB write fails", async () => {
    // Fake env with a broken DB. The handler must swallow the error
    // and return normally so scheduled() is not poisoned.
    const brokenEnv = {
      DB: {
        prepare() {
          throw new Error("simulated D1 outage");
        },
      },
    } as unknown as Env;

    await expect(runWeeklyTransparency(brokenEnv)).resolves.toBeUndefined();
  });
});
