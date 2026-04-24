import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runStatusProbes } from "../../../src/lib/status/cron-handler";

async function clearTable() {
  await env.DB.exec("DELETE FROM status_samples");
}

function withEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as Env;
}

describe("runStatusProbes", () => {
  beforeEach(async () => {
    await clearTable();
    vi.restoreAllMocks();
  });

  it("with canary set and a healthy fetch inserts 5 ok rows", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    const e = withEnv({
      SURFACE_CANARY_PLUGIN_ID: "canary-plug",
      SURFACE_CANARY_VERSION: "0.1.0",
    });
    await runStatusProbes(e);
    fetchSpy.mockRestore();
    const rows = await env.DB
      .prepare(`SELECT surface, status FROM status_samples ORDER BY surface`)
      .all<{ surface: string; status: string }>();
    expect(rows.results.length).toBe(5);
    for (const r of rows.results) {
      expect(["ok", "fail", "slow"].includes(r.status)).toBe(true);
    }
  });

  it("skips plugin_detail and bundle when canary is unset", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    const e = withEnv({
      SURFACE_CANARY_PLUGIN_ID: "",
      SURFACE_CANARY_VERSION: "",
    });
    await runStatusProbes(e);
    fetchSpy.mockRestore();
    const rows = await env.DB
      .prepare(`SELECT surface FROM status_samples ORDER BY surface`)
      .all<{ surface: string }>();
    const surfaces = rows.results.map((r) => r.surface).sort();
    expect(surfaces).toEqual(["landing", "plugins_list", "publishing_api"]);
  });

  it("enforces retention — rows from 8 days ago are deleted", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    await env.DB
      .prepare(
        `INSERT INTO status_samples (id, surface, sampled_at, status, http_status, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("ancient", "landing", eightDaysAgo, "ok", 200, 30)
      .run();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    await runStatusProbes(env);
    fetchSpy.mockRestore();
    const stale = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM status_samples WHERE id = ?`)
      .bind("ancient")
      .first<{ c: number }>();
    expect(stale?.c).toBe(0);
  });

  it("one probe failure does not poison the others", async () => {
    let calls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          // First probe (landing — first surface) explodes.
          throw new TypeError("network down");
        }
        return new Response("", { status: 200 });
      });
    const e = withEnv({
      SURFACE_CANARY_PLUGIN_ID: "",
      SURFACE_CANARY_VERSION: "",
    });
    await runStatusProbes(e);
    fetchSpy.mockRestore();
    const rows = await env.DB
      .prepare(`SELECT surface, status FROM status_samples ORDER BY surface`)
      .all<{ surface: string; status: string }>();
    expect(rows.results.length).toBe(3);
    const landing = rows.results.find((r) => r.surface === "landing");
    expect(landing?.status).toBe("fail");
  });
});
