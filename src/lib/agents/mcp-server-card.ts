const SITE_URL = "https://emdashcms.org";

export interface McpServerCard {
  schemaVersion: string;
  serverInfo: { name: string; version: string };
  transport: { type: "http"; endpoint: string };
  capabilities: { tools: { listChanged: boolean } };
}

export function buildMcpServerCard(): McpServerCard {
  return {
    schemaVersion: "2025-06-18",
    serverInfo: { name: "emdashcms-marketplace", version: "1.0.0" },
    transport: { type: "http", endpoint: `${SITE_URL}/mcp` },
    capabilities: { tools: { listChanged: false } },
  };
}
