const SITE_URL = "https://emdashcms.org";

// Minimal OpenAPI 3.1 document covering the public read endpoints.
// Mutation endpoints are intentionally omitted — they require author auth
// (GitHub device flow) and are documented in /docs/contributors.

export function buildOpenApiDocument(): unknown {
  return {
    openapi: "3.1.0",
    info: {
      title: "EmDash CMS Marketplace API",
      version: "1.0.0",
      description:
        "Public read endpoints for the EmDash CMS community marketplace. Compatible with the MarketplaceClient interface in the EmDash core.",
      license: { name: "MIT", identifier: "MIT" },
      contact: {
        name: "emdashcms.org",
        url: `${SITE_URL}/docs/contributors`,
      },
    },
    servers: [{ url: `${SITE_URL}/api/v1` }],
    paths: {
      "/plugins": {
        get: {
          operationId: "searchPlugins",
          summary: "Search published plugins",
          parameters: [
            {
              name: "query",
              in: "query",
              schema: { type: "string" },
              description: "Free-text query over plugin id, name, description.",
            },
            {
              name: "category",
              in: "query",
              schema: { type: "string" },
            },
            {
              name: "capability",
              in: "query",
              schema: { type: "string" },
            },
            {
              name: "sort",
              in: "query",
              schema: {
                type: "string",
                enum: ["installs", "updated", "created"],
                default: "installs",
              },
            },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50 },
            },
          ],
          responses: {
            "200": {
              description: "Paginated plugin results",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PluginSearchResult" },
                },
              },
            },
          },
        },
      },
      "/plugins/{id}": {
        get: {
          operationId: "getPlugin",
          summary: "Get a plugin by id",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Plugin detail",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PluginDetail" },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
      "/plugins/{id}/versions": {
        get: {
          operationId: "listPluginVersions",
          summary: "List versions for a plugin",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Version list",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/VersionSummary" },
                  },
                },
              },
            },
          },
        },
      },
      "/themes": {
        get: {
          operationId: "searchThemes",
          summary: "Search published themes",
          parameters: [
            { name: "query", in: "query", schema: { type: "string" } },
            { name: "category", in: "query", schema: { type: "string" } },
            { name: "keyword", in: "query", schema: { type: "string" } },
            {
              name: "sort",
              in: "query",
              schema: {
                type: "string",
                enum: ["updated", "created", "downloads"],
                default: "updated",
              },
            },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50 },
            },
          ],
          responses: {
            "200": {
              description: "Paginated theme results",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ThemeSearchResult" },
                },
              },
            },
          },
        },
      },
      "/themes/{id}": {
        get: {
          operationId: "getTheme",
          summary: "Get a theme by id",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Theme detail",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ThemeDetail" },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
    },
    components: {
      schemas: {
        Author: {
          type: "object",
          properties: {
            name: { type: "string" },
            verified: { type: "boolean" },
            avatarUrl: { type: "string", nullable: true },
          },
          required: ["name", "verified", "avatarUrl"],
        },
        AuditSummary: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["pass", "warn", "fail"] },
            riskScore: { type: "number" },
            securityRiskScore: { type: "number" },
            privacyRiskScore: { type: "number" },
          },
        },
        VersionSummary: {
          type: "object",
          properties: {
            version: { type: "string" },
            minEmDashVersion: { type: "string", nullable: true },
            bundleSize: { type: "integer" },
            checksum: { type: "string" },
            capabilities: { type: "array", items: { type: "string" } },
            status: {
              type: "string",
              enum: [
                "pending",
                "published",
                "flagged",
                "rejected",
                "revoked",
              ],
            },
            auditVerdict: {
              type: "string",
              enum: ["pass", "warn", "fail"],
              nullable: true,
            },
            publishedAt: { type: "string", format: "date-time" },
            downloadCount: { type: "integer" },
          },
        },
        PluginSummary: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            shortDescription: { type: "string", nullable: true },
            description: { type: "string", nullable: true },
            author: { $ref: "#/components/schemas/Author" },
            capabilities: { type: "array", items: { type: "string" } },
            keywords: { type: "array", items: { type: "string" } },
            installCount: { type: "integer" },
            downloadCount: { type: "integer" },
            iconUrl: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        PluginDetail: {
          allOf: [{ $ref: "#/components/schemas/PluginSummary" }],
        },
        PluginSearchResult: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/PluginSummary" },
            },
            nextCursor: { type: "string", nullable: true },
          },
        },
        ThemeSummary: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            shortDescription: { type: "string", nullable: true },
            description: { type: "string", nullable: true },
            author: { $ref: "#/components/schemas/Author" },
            keywords: { type: "array", items: { type: "string" } },
            previewUrl: { type: "string", nullable: true },
            demoUrl: { type: "string", nullable: true },
            thumbnailUrl: { type: "string", nullable: true },
            downloadCount: { type: "integer" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        ThemeDetail: {
          allOf: [{ $ref: "#/components/schemas/ThemeSummary" }],
        },
        ThemeSearchResult: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/ThemeSummary" },
            },
            nextCursor: { type: "string", nullable: true },
          },
        },
      },
    },
  };
}
