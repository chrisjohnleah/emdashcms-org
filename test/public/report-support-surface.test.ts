import { describe, expect, it } from "vitest";

import trustSignalsSource from "../../src/components/TrustSignals.astro?raw";
import supportSource from "../../src/pages/support.astro?raw";
import themeDetailSource from "../../src/pages/themes/[...id].astro?raw";

describe("public report and support surfaces", () => {
  it("exposes report entry points for both plugin and theme detail pages", () => {
    expect(trustSignalsSource).toContain("href={`/report/plugin/${plugin.id}`}");
    expect(trustSignalsSource).toContain("Report a problem with this plugin");

    expect(themeDetailSource).toContain("href={`/report/theme/${theme.id}`}");
    expect(themeDetailSource).toContain("Report a problem");
  });

  it("keeps support copy aligned with the current public support model", () => {
    expect(supportSource).toContain("No central forum yet");
    expect(supportSource).toContain("author-provided links");
    expect(supportSource).toContain("listing reports");
    expect(supportSource).toContain("community reports");
    expect(supportSource).toContain("GitHub issues");
  });

  it("routes security concerns through documented policy and report flows", () => {
    expect(supportSource).toContain("Security concerns");
    expect(supportSource).toContain("href: '/docs/security'");
    expect(supportSource).toContain("affected plugin or theme detail page");
  });
});
