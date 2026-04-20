import { describe, it, expect } from "vitest";
import { buildApiCatalog } from "../../src/lib/agents/api-catalog";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "../../src/lib/agents/oauth-metadata";
import { buildMcpServerCard } from "../../src/lib/agents/mcp-server-card";
import { buildSkillsIndex } from "../../src/lib/agents/skills-index";

describe("buildApiCatalog", () => {
  it("produces a single linkset entry anchored at /api/v1", () => {
    const catalog = buildApiCatalog();
    expect(catalog.linkset).toHaveLength(1);
    expect(catalog.linkset[0].anchor).toBe("https://emdashcms.org/api/v1");
  });

  it("advertises service-desc, service-doc, status, and terms-of-service", () => {
    const entry = buildApiCatalog().linkset[0];
    expect(entry["service-desc"]?.[0].href).toBe(
      "https://emdashcms.org/api/v1/openapi.json",
    );
    expect(entry["service-desc"]?.[0].type).toBe(
      "application/vnd.oai.openapi+json",
    );
    expect(entry["service-doc"]?.[0].href).toBe(
      "https://emdashcms.org/docs/contributors",
    );
    expect(entry.status?.[0].href).toContain("/api/v1/plugins?limit=1");
    expect(entry["terms-of-service"]?.[0].href).toBe(
      "https://emdashcms.org/terms",
    );
  });
});

describe("buildAuthorizationServerMetadata", () => {
  it("declares issuer, device + token endpoints, and the device_code grant", () => {
    const meta = buildAuthorizationServerMetadata();
    expect(meta.issuer).toBe("https://emdashcms.org");
    expect(meta.device_authorization_endpoint).toBe(
      "https://emdashcms.org/api/v1/auth/device/code",
    );
    expect(meta.token_endpoint).toBe(
      "https://emdashcms.org/api/v1/auth/device/token",
    );
    expect(meta.grant_types_supported).toContain(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(meta.scopes_supported).toEqual(["read", "publish"]);
  });

  it("does not publish a jwks_uri (site uses HS256 symmetric signing)", () => {
    const meta = buildAuthorizationServerMetadata() as Record<string, unknown>;
    expect(meta.jwks_uri).toBeUndefined();
  });
});

describe("buildProtectedResourceMetadata", () => {
  it("points at /api/v1 with the site itself as the authorization server", () => {
    const meta = buildProtectedResourceMetadata();
    expect(meta.resource).toBe("https://emdashcms.org/api/v1");
    expect(meta.authorization_servers).toEqual(["https://emdashcms.org"]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("buildMcpServerCard", () => {
  it("advertises the /mcp HTTP transport with tools capability", () => {
    const card = buildMcpServerCard();
    expect(card.serverInfo.name).toBe("emdashcms-marketplace");
    expect(card.transport.type).toBe("http");
    expect(card.transport.endpoint).toBe("https://emdashcms.org/mcp");
    expect(card.capabilities.tools.listChanged).toBe(false);
  });
});

describe("buildSkillsIndex", () => {
  it("includes the marketplace-search skill with the supplied sha256", () => {
    const index = buildSkillsIndex("abc123");
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0].name).toBe("marketplace-search");
    expect(index.skills[0].sha256).toBe("abc123");
    expect(index.skills[0].url).toBe(
      "https://emdashcms.org/.well-known/agent-skills/marketplace-search/SKILL.md",
    );
  });
});
