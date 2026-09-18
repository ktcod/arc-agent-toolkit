import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { assertAddress, erc20Meta, type ChainKey } from "../upstream/evm.js";
import { poolsForToken, deepestPool, type Pool } from "../upstream/dexscreener.js";
import {
  CANONICAL,
  canonicalByAddress,
  collidesWithCanonical,
  lookupCanonical,
  type RegistryAnswer,
} from "../upstream/arcRegistry.js";

export const TOOL_NAME = "arc_asset_verify";
export const TOOL_PRICE = "$0.002";

export type Verdict = "canonical" | "impersonator" | "unrelated";

export interface AssetVerification {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  verdict: Verdict;
  /** When verdict is "canonical", which Circle contract this is. */
  canonicalSymbol: string | null;
  canonicalRole: string | null;
  /** When verdict is "impersonator", the canonical symbol being imitated. */
  impersonates: string | null;
  /** The canonical address the caller probably wanted. */
  realAddress: string | null;
  reasons: string[];
  liquidityUsd: number | null;
  registrySource: "onchain" | "builtin";
  warnings: string[];
  source: string;
}

/**
 * Decide the verdict. Pure, so the logic is testable without any network.
 *
 * Scope is deliberately narrow: this answers "is this the real Circle asset it appears to be?",
 * not "is this token safe?". Honeypot detection and contract-risk scoring are a different
 * product and a crowded one.
 */
export function decide(
  address: string,
  symbol: string | null,
  registry: RegistryAnswer,
): {
  verdict: Verdict;
  impersonates: string | null;
  realAddress: string | null;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (registry.isCanonical) {
    reasons.push(
      `Address is registered as canonical Circle infrastructure (${registry.source === "onchain" ? "on-chain registry" : "built-in table"}).`,
    );
    return { verdict: "canonical", impersonates: null, realAddress: address, reasons };
  }

  const collision = collidesWithCanonical(symbol);
  if (collision) {
    reasons.push(
      `Symbol "${symbol}" collides with the canonical Circle asset ${collision}, but this address is NOT that contract.`,
    );
    reasons.push("On Arc, USDC is the gas asset, which makes its ticker the highest-value squat.");
    return { verdict: "impersonator", impersonates: collision, realAddress: null, reasons };
  }

  reasons.push("No collision with a canonical Circle symbol; this is an ordinary token.");
  return { verdict: "unrelated", impersonates: null, realAddress: null, reasons };
}

function canonicalAddressFor(symbol: string): string | null {
  return CANONICAL.find((c) => c.symbol === symbol)?.address ?? null;
}

export async function verifyAsset(
  address: string,
  registryAddress: string | undefined,
  chain: ChainKey = "arc",
  env?: Record<string, string | undefined>,
): Promise<AssetVerification> {
  const addr = assertAddress(address, "address");
  const warnings: string[] = [];

  // Registry + on-chain metadata are the CORE: a failure here must fail the call.
  const [registry, meta] = await Promise.all([
    lookupCanonical(chain, addr, registryAddress, env),
    erc20Meta(chain, addr, env),
  ]);

  // DexScreener is ENRICHMENT: a failure degrades the answer, it does not invalidate it.
  let pools: Pool[] = [];
  try {
    pools = await poolsForToken(addr);
  } catch (e) {
    warnings.push(
      `Liquidity lookup unavailable (${e instanceof Error ? e.message : String(e)}); verdict is unaffected.`,
    );
  }
  const best = deepestPool(pools);

  const { verdict, impersonates, reasons } = decide(addr, meta.symbol, registry);
  const canonicalEntry = canonicalByAddress(addr);

  if (verdict === "impersonator" && best?.liquidityUsd !== undefined && best?.liquidityUsd !== null) {
    reasons.push(`Deepest pool holds only $${best.liquidityUsd.toLocaleString()} of liquidity.`);
  }

  return {
    address: addr,
    symbol: meta.symbol,
    name: best?.baseName ?? null,
    decimals: meta.decimals,
    verdict,
    canonicalSymbol: canonicalEntry?.symbol ?? registry.symbol,
    canonicalRole: canonicalEntry?.role ?? null,
    impersonates,
    realAddress: impersonates ? canonicalAddressFor(impersonates) : (canonicalEntry?.address ?? null),
    reasons,
    liquidityUsd: best?.liquidityUsd ?? null,
    registrySource: registry.source,
    warnings,
    source: "ArcAssetRegistry + live Arc RPC" + (pools.length ? " + DexScreener" : ""),
  };
}

const DESCRIPTION = `Is this Arc address the real Circle asset it claims to be, or an impersonator?

On Arc, USDC is the gas asset, which makes its ticker the single highest-value thing to squat on the chain. Tokens trading as USDC-alikes already exist: USDCARC at 0xaaC788737179Cd696d19b1A09c5392033C9127A6 is a real example with roughly $2.5k of liquidity, against genuine USDC at 0x3600000000000000000000000000000000000000.

Three verdicts:
  canonical    — the address IS registered Circle infrastructure (USDC, EURC, USYC, Gateway, CCTP, Permit2, Multicall3...)
  impersonator — the symbol collides with a canonical Circle asset but the address does not match
  unrelated    — no collision; an ordinary token

The canonical list is read from an ArcAssetRegistry contract deployed on Arc mainnet, so you can verify the answer on-chain rather than trusting this API. If that read fails, a built-in table transcribed from the Arc docs answers instead, and registrySource says which was used.

When to use: before approving, swapping into, or accepting a token that presents itself as USDC, EURC or USYC; resolving the true address of a Circle contract.

When NOT to use: general token-safety scoring, honeypot detection or rug prediction. This tool does not attempt those and will not pretend to.

Args:
  - address (string, required): the 0x address to check.

Returns structuredContent:
  {
    "address": "0xaac7...27a6", "symbol": "USDCARC", "decimals": 18,
    "verdict": "impersonator", "impersonates": "USDC",
    "realAddress": "0x3600000000000000000000000000000000000000",
    "reasons": ["Symbol \\"USDCARC\\" collides with the canonical Circle asset USDC, but this address is NOT that contract.", "..."],
    "liquidityUsd": 2481, "registrySource": "onchain", "warnings": []
  }

Liquidity is enrichment: if DexScreener is unreachable the verdict still stands, liquidityUsd is null and a warning is attached rather than the call failing.`;

export const arcAssetVerifyTool: ToolModule = {
  name: TOOL_NAME,
  title: "Arc Canonical Asset Verification",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "0x address to check on Arc." } },
      required: ["address"],
    },
    inputExample: { address: "0x3600000000000000000000000000000000000000" },
    output: { example: { address: "0x3600…0000", verdict: "canonical", impersonates: null } },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Arc Canonical Asset Verification",
        description: DESCRIPTION,
        inputSchema: { address: z.string().describe("0x address to check on Arc.") },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ address }) => {
        const env = globalThis.process?.env as Record<string, string | undefined> | undefined;
        const result = await verifyAsset(address, env?.ARC_REGISTRY_ADDRESS, "arc", env);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
