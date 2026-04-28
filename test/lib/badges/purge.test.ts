/**
 * Phase 22 D-13 regression: purgeBadges fans out cache.delete calls for
 * every entry in BADGE_METRICS — currently 6 (the original 5 plus
 * lifecycle). The assertion is driven off BADGE_METRICS itself so future
 * additions to the constant automatically extend coverage (EHAA-08), and
 * the dashboard mutation file (`src/pages/dashboard/plugins/[id].astro`)
 * is asserted to import and invoke the helper inside each of the four
 * publisher branches (D-12).
 */

import { describe, it, expect, vi } from "vitest";
import dashboardPluginSource from "../../../src/pages/dashboard/plugins/[id].astro?raw";
import { purgeBadges } from "../../../src/lib/badges/purge";
import { BADGE_METRICS } from "../../../src/lib/badges/metrics";

describe("purgeBadges fan-out (D-13)", () => {
  it("calls caches.default.delete exactly BADGE_METRICS.length times (currently 6) with the canonical badge URL for each metric", async () => {
    const deleteSpy = vi
      .spyOn(caches.default, "delete")
      .mockResolvedValue(true);
    try {
      await purgeBadges("https://emdashcms.org", "test-plugin-id");
      // Drive the count off the source-of-truth constant so a future
      // metric addition (EHAA-08) automatically extends this regression.
      expect(deleteSpy).toHaveBeenCalledTimes(BADGE_METRICS.length);
      const urls = deleteSpy.mock.calls.map((c) => c[0]);
      expect(urls).toEqual(
        BADGE_METRICS.map(
          (m) =>
            `https://emdashcms.org/badges/v1/plugin/test-plugin-id/${m}.svg`,
        ),
      );
      // Lifecycle is the Phase 22 addition — assert it explicitly so a
      // regression that strips the metric is caught even if the count
      // assertion is somehow loosened.
      expect(urls).toContain(
        "https://emdashcms.org/badges/v1/plugin/test-plugin-id/lifecycle.svg",
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("emits the lifecycle URL as the LAST entry (matches BADGE_METRICS ordering)", async () => {
    const deleteSpy = vi
      .spyOn(caches.default, "delete")
      .mockResolvedValue(true);
    try {
      await purgeBadges("https://emdashcms.org", "ordering-check");
      const urls = deleteSpy.mock.calls.map((c) => c[0]);
      expect(urls[urls.length - 1]).toBe(
        "https://emdashcms.org/badges/v1/plugin/ordering-check/lifecycle.svg",
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring: the dashboard mutation page imports purgeBadges and invokes it
// inside each of the four publisher branches before redirecting (D-12).
// File-level assertions because exercising the real Astro page would
// require booting the route handler; the runtime fan-out is covered by
// the helper test above.
// ---------------------------------------------------------------------------

describe("dashboard mutation purgeBadges wiring (D-12)", () => {
  it("imports purgeBadges from the badges library", () => {
    expect(dashboardPluginSource).toMatch(
      /import\s*\{\s*purgeBadges\s*\}\s*from\s+["'][^"']*\/badges\/purge["']/,
    );
  });

  it("calls purgeBadges in every publisher mutation branch (deprecate / undeprecate / unlist / relist)", () => {
    // Match all `await purgeBadges(new URL(Astro.request.url).origin, pluginId!);`
    // call sites. Four publisher actions × one call each = 4 occurrences
    // (the deprecate branch's call lives on the success path only —
    // failure paths re-render the modal and must NOT trigger a purge).
    const purgeCalls = dashboardPluginSource.match(
      /await\s+purgeBadges\(\s*new URL\(Astro\.request\.url\)\.origin,\s*pluginId!\s*\)/g,
    );
    expect(purgeCalls?.length ?? 0).toBe(4);
  });

  for (const action of [
    "undeprecate",
    "unlist",
    "relist",
  ] as const) {
    it(`wires purgeBadges into the ${action} branch before the redirect`, () => {
      // Match the action handler followed by the await-the-mutation +
      // await-purgeBadges + Astro.redirect triplet so a future refactor
      // that drops the purge between the mutation and the redirect is
      // caught immediately.
      const re = new RegExp(
        `action\\s*===\\s*['"]${action}['"][\\s\\S]{0,400}?await\\s+purgeBadges\\(\\s*new URL\\(Astro\\.request\\.url\\)\\.origin,\\s*pluginId!\\s*\\)[\\s\\S]{0,200}?Astro\\.redirect`,
      );
      expect(dashboardPluginSource).toMatch(re);
    });
  }

  it("wires purgeBadges into the deprecate success branch (NOT the failure path)", () => {
    // Success path: result.ok -> purgeBadges -> redirect.
    expect(dashboardPluginSource).toMatch(
      /} else \{[\s\S]{0,400}?await\s+purgeBadges\(\s*new URL\(Astro\.request\.url\)\.origin,\s*pluginId!\s*\)[\s\S]{0,200}?return Astro\.redirect\(Astro\.url\.pathname \+ '\?deprecated=true'\)/,
    );
    // Failure path: deprecateError set, modal re-opened, NO purge in the
    // !result.ok block before the inline drafted modal state.
    const failureBlock = dashboardPluginSource.match(
      /if \(!result\.ok\) \{[\s\S]*?successorName: null,\s*\};/,
    );
    expect(failureBlock).toBeTruthy();
    expect(failureBlock?.[0]).not.toMatch(/purgeBadges/);
  });
});
