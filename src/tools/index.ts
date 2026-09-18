import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPriceSpec } from "../config.js";
import type { ToolModule } from "./types.js";
import { arcChainStatusTool } from "./arcChainStatus.js";
import { arcGasQuoteTool } from "./arcGasQuote.js";
import { arcTxFinalityTool } from "./arcTxFinality.js";
import { arcAssetVerifyTool } from "./arcAssetVerify.js";
import { arcTokenLiquidityTool } from "./arcTokenLiquidity.js";

export type { ToolModule } from "./types.js";

/**
 * The full tool registry. This is the ONLY file that changes when adding a tool: implement a new
 * ToolModule and append it here.
 *
 * Every tool is network-backed and MUST throw on upstream failure, so the payment gate skips
 * settlement and the caller is not charged for a result they never received.
 */
export const tools: ToolModule[] = [
  arcChainStatusTool, // free — the discovery surface
  arcGasQuoteTool,
  arcTxFinalityTool,
  arcAssetVerifyTool,
  arcTokenLiquidityTool,
];

export function registerTools(server: McpServer): void {
  for (const tool of tools) tool.register(server);
}

export interface PaidToolSpec extends ToolPriceSpec {
  title: string;
  description: string;
  discovery?: ToolModule["discovery"];
}

/** Specs for tools that require x402 payment (price !== null). */
export function paidToolSpecs(): PaidToolSpec[] {
  return tools
    .filter((t): t is ToolModule & { price: string } => t.price !== null)
    .map((t) => ({
      name: t.name,
      defaultPrice: t.price,
      title: t.title,
      description: t.description,
      discovery: t.discovery,
    }));
}
