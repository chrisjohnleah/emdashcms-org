import { describe, it } from "vitest";
// Coverage for FEED-07 robots.txt discoverability.

describe("public/robots.txt", () => {
  it.todo("contains /feeds/plugins/new.xml as a discovery hint");
  it.todo("contains /feeds/plugins/updated.xml as a discovery hint");
  it.todo("contains /feeds/themes/new.xml as a discovery hint");
  it.todo("does NOT contain per-category feed URLs (D-33: category feeds are discovered via <link rel=alternate>)");
  it.todo("preserves existing Sitemap: directive");
  it.todo("preserves existing User-agent: * / Allow: / directives");
});
