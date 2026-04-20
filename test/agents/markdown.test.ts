import { describe, it, expect } from "vitest";
import { buildHomepageMarkdown, buildPluginsIndexMarkdown } from "../../src/lib/agents/markdown";
import { env } from "cloudflare:test";

describe("markdown builders", () => {
  it("buildHomepageMarkdown emits an H1, blockquote, and the agent pointers even when the DB is empty", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM plugin_audits"),
      env.DB.prepare("DELETE FROM plugin_versions"),
      env.DB.prepare("DELETE FROM plugins"),
      env.DB.prepare("DELETE FROM themes"),
      env.DB.prepare("DELETE FROM authors"),
    ]);

    const md = await buildHomepageMarkdown(env.DB);
    expect(md.startsWith("# emdashcms.org")).toBe(true);
    expect(md).toContain("> A community marketplace");
    expect(md).toContain("## For agents");
    expect(md).toContain("https://emdashcms.org/mcp");
    expect(md).toContain("/api/v1/openapi.json");
  });

  it("buildPluginsIndexMarkdown reflects the filter summary even with zero results", async () => {
    const md = await buildPluginsIndexMarkdown(
      env.DB,
      new URLSearchParams("query=nonesuch&category=analytics"),
    );
    expect(md).toContain("# Plugins — emdashcms.org");
    expect(md).toContain('query="nonesuch"');
    expect(md).toContain("category=analytics");
    expect(md).toContain("No plugins match");
  });
});
