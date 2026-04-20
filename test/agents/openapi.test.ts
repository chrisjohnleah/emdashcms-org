import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "../../src/lib/agents/openapi";

describe("buildOpenApiDocument", () => {
  it("emits a 3.1 document with the five read endpoints only", () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://emdashcms.org/api/v1");

    const paths = Object.keys(doc.paths);
    expect(paths).toContain("/plugins");
    expect(paths).toContain("/plugins/{id}");
    expect(paths).toContain("/plugins/{id}/versions");
    expect(paths).toContain("/themes");
    expect(paths).toContain("/themes/{id}");

    // No write endpoints — mutations require auth and are intentionally
    // out of scope for the agent-readiness doc.
    expect(paths).not.toContain("/plugins/{id}/versions/{version}/bundle");
    for (const p of paths) {
      const methods = Object.keys(
        doc.paths[p] as Record<string, unknown>,
      );
      expect(methods).toEqual(["get"]);
    }
  });
});
