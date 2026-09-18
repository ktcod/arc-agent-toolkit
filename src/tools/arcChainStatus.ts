import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import {
  CHAINS,
  NATIVE_DECIMALS,
  hexToBigInt,
  rpcBatchRaw,
  type BlockHeader,
  type ChainKey,
} from "../upstream/evm.js";
import { CANONICAL } from "../upstream/arcRegistry.js";

export const TOOL_NAME = "arc_chain_status";
export const TOOL_PRICE = null; // free: this is the discovery surface

export interface ChainStatus {
  chain: string;
  chainId: number;
  caip2: string;
  latestBlock: number | null;
  safeBlock: number | null;
  finalizedBlock: number | null;
  blockTimeSeconds: number | null;
  gasPriceGwei: number | null;
  transferCostUsdc: number | null;
  nativeGasAsset: string;
  canonical: Array<{ symbol: string; address: string; role: string }>;
  source: string;
}

/** 21,000 gas: the cost of a plain value transfer, verified on Arc mainnet 2026-09-18. */
export const TRANSFER_GAS = 21_000n;

/**
 * Cost of a transaction, in USDC dollars.
 *
 * Arc's native unit is 18 decimals even though it IS USDC (the ERC-20 at 0x3600…0000 reports 6).
 * Dividing by 1e18 rather than 1e6 is the whole point of this function; getting it wrong is a
 * factor of a trillion. See VERIFICATION.md.
 */
export function costInUsdc(gasPriceWei: bigint, gasUnits: bigint): number {
  return Number(gasPriceWei * gasUnits) / 10 ** NATIVE_DECIMALS;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Pull number and timestamp out of a block header, tolerating a missing or malformed one. */
export function readBlock(v: unknown): { number: number | null; timestamp: number | null } {
  if (!v || typeof v !== "object") return { number: null, timestamp: null };
  const b = v as BlockHeader;
  const n = hexToBigInt(b.number);
  const t = hexToBigInt(b.timestamp);
  return { number: n === null ? null : Number(n), timestamp: t === null ? null : Number(t) };
}

export async function getChainStatus(
  chain: ChainKey = "arc",
  env?: Record<string, string | undefined>,
): Promise<ChainStatus> {
  const spec = CHAINS[chain];
  const [gasRaw, latestRaw, safeRaw, finalizedRaw, prevRaw] = await rpcBatchRaw(
    chain,
    [
      { method: "eth_gasPrice", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_getBlockByNumber", params: ["safe", false] },
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
      { method: "eth_getBlockByNumber", params: ["pending", false] },
    ],
    env,
  );

  const latest = readBlock(latestRaw);
  if (gasRaw === null && latest.number === null) {
    throw new UpstreamError(`${spec.name} RPC`, "neither gas price nor latest block was readable");
  }

  const safe = readBlock(safeRaw);
  const finalized = readBlock(finalizedRaw);
  const gasPriceWei = hexToBigInt(typeof gasRaw === "string" ? gasRaw : null);

  // Block time from the gap between the latest block and the one before it, when both are known.
  let blockTimeSeconds: number | null = null;
  const prev = readBlock(prevRaw);
  if (latest.timestamp !== null && prev.timestamp !== null && prev.timestamp > latest.timestamp) {
    blockTimeSeconds = prev.timestamp - latest.timestamp;
  }

  return {
    chain: spec.name,
    chainId: spec.id,
    caip2: spec.caip2,
    latestBlock: latest.number,
    safeBlock: safe.number,
    finalizedBlock: finalized.number,
    blockTimeSeconds,
    gasPriceGwei: gasPriceWei === null ? null : Number(gasPriceWei) / 1e9,
    transferCostUsdc: gasPriceWei === null ? null : round6(costInUsdc(gasPriceWei, TRANSFER_GAS)),
    nativeGasAsset: "USDC",
    canonical: CANONICAL.map((c) => ({ symbol: c.symbol, address: c.address, role: c.role })),
    source: `Live RPC on ${spec.name} (${spec.rpcs.length} providers, rotated)`,
  };
}

const DESCRIPTION = `Live status of the Arc blockchain, plus the canonical Circle contract addresses. Free, no payment required.

Arc is Circle's stablecoin-native L1: USDC is the gas asset, and finality is deterministic rather than probabilistic.

Returns the latest, safe and finalized block heights (Arc supports all three tags), the current gas price, what a plain transfer costs in USDC dollars, and the full canonical address table (USDC, EURC, USYC, Gateway, CCTP, Permit2, Multicall3).

When to use: orienting on Arc before transacting, checking the chain is live, or resolving a canonical Circle contract address without trusting a third-party list.

When NOT to use: you want per-token data (use arc_token_liquidity) or to check one specific address (use arc_asset_verify).

Args: none.

Returns structuredContent:
  {
    "chain": "Arc", "chainId": 5042, "caip2": "eip155:5042",
    "latestBlock": 21561462, "safeBlock": 21561460, "finalizedBlock": 21561461,
    "gasPriceGwei": 20, "transferCostUsdc": 0.00042, "nativeGasAsset": "USDC",
    "canonical": [{ "symbol": "USDC", "address": "0x3600...0000", "role": "Circle USDC (also the native gas asset)" }]
  }

NOTE ON DECIMALS: Arc's native gas unit is 18 decimals, while the USDC ERC-20 at 0x3600...0000 reports 6. transferCostUsdc is already converted to dollars.`;

export const arcChainStatusTool: ToolModule = {
  name: TOOL_NAME,
  title: "Arc Chain Status",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Arc Chain Status",
        description: DESCRIPTION,
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => {
        const result = await getChainStatus(
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
