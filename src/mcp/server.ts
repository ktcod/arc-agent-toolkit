import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../tools/index.js";

// The Official MCP Registry searches on NAME only (substring match; title and description are
// NOT indexed), so the name has to carry the keywords an agent would actually search for.
export const SERVER_NAME = "arc-agent-toolkit-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Human-facing service name shared by every x402 resource this server exposes.
 *
 * The Bazaar groups catalog entries by `serviceName`, so all 21 per-tool routes must report the
 * SAME value to appear as one coherent service rather than 21 unrelated listings.
 * Keep it short and ASCII: the CDP facilitator rejects payloads with oversized resource metadata.
 */
export const SERVICE_TITLE = "Arc Agent Toolkit";

/** Build a fresh MCP server with all tools registered (stateless: one per request). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  return server;
}
