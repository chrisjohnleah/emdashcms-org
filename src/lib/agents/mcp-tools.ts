import { searchPlugins, getPluginDetail, getThemeDetail } from "../db/queries";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "search_plugins",
    description:
      "Search published plugins on emdashcms.org. Returns up to `limit` summaries, optionally filtered by free-text query, category, or capability. Results include audit verdict — prefer plugins with verdict='pass'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query." },
        category: { type: "string", description: "Plugin category slug." },
        capability: {
          type: "string",
          description: "Manifest capability the plugin must declare.",
        },
        sort: {
          type: "string",
          enum: ["installs", "updated", "created"],
          default: "installs",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
    },
  },
  {
    name: "get_plugin",
    description:
      "Fetch the full detail for a single plugin by id, including latest version, audit findings, readme, and screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Plugin id (slug)." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_theme",
    description:
      "Fetch the full detail for a single theme by id, including screenshots, keywords, and repository/npm pointers.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Theme id (slug)." },
      },
      required: ["id"],
    },
  },
];

export class McpToolError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new McpToolError(-32602, `Invalid argument: '${field}' is required`);
  }
  return value;
}

function clampLimit(value: unknown): number {
  const n = typeof value === "number" ? value : 10;
  if (!Number.isFinite(n)) return 10;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

export async function callMcpTool(
  db: D1Database,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_plugins": {
      const result = await searchPlugins(db, {
        query: typeof args.query === "string" ? args.query : "",
        category: typeof args.category === "string" ? args.category : null,
        capability:
          typeof args.capability === "string" ? args.capability : null,
        sort: typeof args.sort === "string" ? args.sort : "installs",
        cursor: null,
        limit: clampLimit(args.limit),
      });
      return {
        items: result.items,
        nextCursor: result.nextCursor,
      };
    }

    case "get_plugin": {
      const id = requireString(args.id, "id");
      const detail = await getPluginDetail(db, id);
      if (!detail) {
        throw new McpToolError(-32004, `Plugin not found: ${id}`);
      }
      return detail;
    }

    case "get_theme": {
      const id = requireString(args.id, "id");
      const detail = await getThemeDetail(db, id);
      if (!detail) {
        throw new McpToolError(-32004, `Theme not found: ${id}`);
      }
      return detail;
    }

    default:
      throw new McpToolError(-32601, `Unknown tool: ${name}`);
  }
}
