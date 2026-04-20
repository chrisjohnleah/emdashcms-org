import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleWellKnown } from "../../src/lib/agents/well-known";

function req(path: string, method = "GET"): Request {
  return new Request(`https://emdashcms.org${path}`, { method });
}

describe("handleWellKnown dispatch", () => {
  it("returns null for unrelated paths", async () => {
    expect(await handleWellKnown(req("/"), env)).toBeNull();
    expect(await handleWellKnown(req("/api/v1/plugins"), env)).toBeNull();
  });

  it("returns null for non-GET/HEAD methods", async () => {
    expect(
      await handleWellKnown(req("/.well-known/api-catalog", "POST"), env),
    ).toBeNull();
  });

  it("serves /.well-known/api-catalog as application/linkset+json", async () => {
    const res = await handleWellKnown(req("/.well-known/api-catalog"), env);
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toContain(
      "application/linkset+json",
    );
    const body = (await res!.json()) as { linkset: unknown[] };
    expect(Array.isArray(body.linkset)).toBe(true);
  });

  it("serves OAuth AS + protected-resource metadata", async () => {
    const as = await handleWellKnown(
      req("/.well-known/oauth-authorization-server"),
      env,
    );
    expect(as).not.toBeNull();
    const asBody = (await as!.json()) as { issuer: string };
    expect(asBody.issuer).toBe("https://emdashcms.org");

    const pr = await handleWellKnown(
      req("/.well-known/oauth-protected-resource"),
      env,
    );
    expect(pr).not.toBeNull();
    const prBody = (await pr!.json()) as { resource: string };
    expect(prBody.resource).toBe("https://emdashcms.org/api/v1");
  });

  it("serves the MCP server card at /.well-known/mcp/server-card.json", async () => {
    const res = await handleWellKnown(
      req("/.well-known/mcp/server-card.json"),
      env,
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as {
      serverInfo: { name: string };
      transport: { endpoint: string };
    };
    expect(body.serverInfo.name).toBe("emdashcms-marketplace");
    expect(body.transport.endpoint).toBe("https://emdashcms.org/mcp");
  });
});
