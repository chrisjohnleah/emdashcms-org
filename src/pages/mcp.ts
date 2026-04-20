import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { MCP_TOOLS, callMcpTool, McpToolError } from "../lib/agents/mcp-tools";

export const prerender = false;

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "emdashcms-marketplace", version: "1.0.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResponse(id: number | string | null | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
) {
  return {
    jsonrpc: "2.0" as const,
    id: id ?? null,
    error: { code, message },
  };
}

async function dispatch(req: JsonRpcRequest): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return rpcResponse(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });

    case "notifications/initialized":
    case "ping":
      // Notifications: no response expected per JSON-RPC. Ping: return {}.
      return req.method === "ping" ? rpcResponse(req.id, {}) : null;

    case "tools/list":
      return rpcResponse(req.id, { tools: MCP_TOOLS });

    case "tools/call": {
      const name =
        typeof req.params?.name === "string" ? req.params.name : "";
      const args =
        (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        const data = await callMcpTool(env.DB, name, args);
        return rpcResponse(req.id, {
          content: [
            { type: "text", text: JSON.stringify(data) },
          ],
          structuredContent: data,
        });
      } catch (err) {
        if (err instanceof McpToolError) {
          return rpcError(req.id, err.code, err.message);
        }
        console.error("[mcp] tool call failed:", err);
        return rpcError(req.id, -32603, "Internal server error");
      }
    }

    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32700, "Parse error")),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Batched requests per JSON-RPC 2.0 §6.
  if (Array.isArray(body)) {
    const results = await Promise.all(
      body.map((entry) => dispatch(entry as JsonRpcRequest)),
    );
    const filtered = results.filter((r) => r !== null);
    return new Response(JSON.stringify(filtered), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const result = await dispatch(body as JsonRpcRequest);
  if (result === null) {
    // Notification — no response body per spec.
    return new Response(null, { status: 204 });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

export const GET: APIRoute = async () => {
  // Clients that GET /mcp expecting SSE get a 405 with a pointer to the
  // server card so they can retry with the correct transport. Keeping the
  // transport Streamable-HTTP-only lets us stay off Durable Objects.
  return new Response(
    JSON.stringify({
      error: "Use POST with JSON-RPC 2.0 payloads.",
      card: "https://emdashcms.org/.well-known/mcp/server-card.json",
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Allow: "POST",
      },
    },
  );
};
