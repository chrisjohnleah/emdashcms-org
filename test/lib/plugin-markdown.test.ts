import { describe, it, expect } from "vitest";
import { renderPluginMarkdown } from "../../src/lib/markdown";

describe("renderPluginMarkdown", () => {
  it("renders headings and lists", () => {
    const html = renderPluginMarkdown("### How it looks\n- one\n- two")!;
    expect(html).toContain("<h3>How it looks</h3>");
    expect(html).toContain("<li>one</li>");
  });

  it("escapes raw HTML and drops javascript: links", () => {
    const html = renderPluginMarkdown('<script>alert(1)</script> [x](javascript:alert(1))')!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
  });

  it("hardens outbound links", () => {
    expect(renderPluginMarkdown("https://example.com")).toContain('rel="noopener noreferrer"');
  });

  it("returns null for blank input", () => {
    expect(renderPluginMarkdown("   ")).toBeNull();
    expect(renderPluginMarkdown(null)).toBeNull();
  });
});
