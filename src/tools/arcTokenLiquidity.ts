import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { assertAddress, erc20Meta, type ChainKey } from "../upstream/evm.js";
import { poolsForToken, type Pool } from "../upstream/dexscreener.js";

export const TOOL_NAME = "arc_token_liquidity";
export const TOOL_PRICE = "$0.005";

export type Depth = "none" | "thin" | "moderate" | "deep";

export interface LiquidityReport {
  address: string;
  symbol: string | null;
  decimals: number | null;
  poolCount: number;
  totalLiquidityUsd: number | null;
  marketCapUsd: number | null;
  /** Market cap divided by pooled liquidity. High means the price is thinly supported. */
  mcapToLiquidityRatio: number | null;
  depth: Depth;
  /** What fraction of the market cap could actually be realised, very roughly. */
  verdict: string;
  pools: Pool[];
  source: string;
}

/**
 * Classify pool depth. Thresholds are deliberately blunt and stated in the output, because a
 * precise-looking score would imply a confidence this data does not support.
 */
export function classifyDepth(totalLiquidityUsd: number | null): Depth {
  if (totalLiquidityUsd === null || totalLiquidityUsd <= 0) return "none";
  if (totalLiquidityUsd < 25_000) return "thin";
  if (totalLiquidityUsd < 250_000) return "moderate";
  return "deep";
}

export function verdictFor(depth: Depth, ratio: number | null): string {
  if (depth === "none") return "No indexed pool. There is nothing to trade against.";
  const base = {
    thin: "Thin. A modest sell would move the price substantially.",
    moderate: "Moderate. Ordinary position sizes should clear; large ones will not.",
    deep: "Deep relative to the rest of Arc today.",
  }[depth];
  if (ratio !== null && ratio > 20) {
    return `${base} Market cap is ${Math.round(ratio)}x pooled liquidity, so the quoted cap is largely notional.`;
  }
  return base;
}

export function summarise(pools: Pool[]): {
  total: number | null;
  mcap: number | null;
  ratio: number | null;
} {
  if (pools.length === 0) return { total: null, mcap: null, ratio: null };
  let total = 0;
  let sawLiquidity = false;
  let mcap: number | null = null;
  for (const p of pools) {
    if (p.liquidityUsd !== null) {
      total += p.liquidityUsd;
      sawLiquidity = true;
    }
    // Market cap is a token-level fact; every pool reports the same figure. Take the first.
    if (mcap === null && p.marketCapUsd !== null) mcap = p.marketCapUsd;
  }
  const t = sawLiquidity ? total : null;
  return { total: t, mcap, ratio: t && t > 0 && mcap !== null ? mcap / t : null };
}

export async function getLiquidity(
  address: string,
  chain: ChainKey = "arc",
  env?: Record<string, string | undefined>,
): Promise<LiquidityReport> {
  const addr = assertAddress(address, "address");

  // DexScreener IS the core source here, so its failure must fail the call and skip settlement.
  const [pools, meta] = await Promise.all([
    poolsForToken(addr),
    erc20Meta(chain, addr, env).catch(() => ({ address: addr, symbol: null, decimals: 18 })),
  ]);

  const { total, mcap, ratio } = summarise(pools);
  const depth = classifyDepth(total);

  return {
    address: addr,
    symbol: meta.symbol ?? pools[0]?.baseSymbol ?? null,
    decimals: meta.decimals ?? null,
    poolCount: pools.length,
    totalLiquidityUsd: total === null ? null : Math.round(total),
    marketCapUsd: mcap === null ? null : Math.round(mcap),
    mcapToLiquidityRatio: ratio === null ? null : Math.round(ratio * 100) / 100,
    depth,
    verdict: verdictFor(depth, ratio),
    pools,
    source: "DexScreener (Arc) + live Arc RPC for token metadata",
  };
}

const DESCRIPTION = `Can you actually get out? Pooled liquidity for an Arc token, against its claimed market cap.

Market cap on a young chain is a notional figure: it is price times supply, and the price comes from a pool that may hold a few thousand dollars. This tool reports what is actually pooled, across every Arc pool DexScreener indexes, and the ratio of claimed cap to real liquidity.

Depth bands (blunt on purpose, and stated so you can disagree):
  none     — no indexed pool
  thin     — under $25k pooled
  moderate — $25k to $250k
  deep     — above $250k

When to use: sizing a position, deciding whether a quoted market cap means anything, or screening a token before an agent trades it.

When NOT to use: you want price history or OHLCV candles, or a safety verdict (for canonical-asset impersonation use arc_asset_verify).

Args:
  - address (string, required): the token's 0x address on Arc.

Returns structuredContent:
  {
    "address": "0x41358def...6e6a", "symbol": "DUKE", "decimals": 18,
    "poolCount": 1, "totalLiquidityUsd": 146135, "marketCapUsd": 1144924,
    "mcapToLiquidityRatio": 7.83, "depth": "moderate",
    "verdict": "Moderate. Ordinary position sizes should clear; large ones will not.",
    "pools": [{ "dex": "uniswap", "liquidityUsd": 146135, "priceUsd": 0.0011, "url": "https://dexscreener.com/arc/..." }]
  }

A token with no indexed pool returns poolCount 0 and depth "none" — that is a finding, not an error. If DexScreener itself is unreachable the call errors, and an errored call is never billed.`;

export const arcTokenLiquidityTool: ToolModule = {
  name: TOOL_NAME,
  title: "Arc Token Liquidity",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Token 0x address on Arc." } },
      required: ["address"],
    },
    inputExample: { address: "0x41358Defd0dedc90528b3F1835715E907B686e6a" },
    output: { example: { symbol: "DUKE", totalLiquidityUsd: 146135, depth: "moderate" } },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Arc Token Liquidity",
        description: DESCRIPTION,
        inputSchema: { address: z.string().describe("Token 0x address on Arc.") },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ address }) => {
        const result = await getLiquidity(
          address,
          "arc",
          globalThis.process?.env as Record<string, string | undefined> | undefined,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
