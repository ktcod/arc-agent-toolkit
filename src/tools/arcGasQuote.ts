import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import { CHAINS, NATIVE_DECIMALS, hexToBigInt, rpcBatch, assertAddress } from "../upstream/evm.js";

export const TOOL_NAME = "arc_gas_quote";
export const TOOL_PRICE = "$0.001";

/** Reference gas costs on Arc. 21,000 for a transfer is EVM-standard and verified on Arc. */
export const GAS_PRESETS = {
  transfer: 21_000n,
  erc20Transfer: 65_000n,
  swap: 150_000n,
  deploy: 500_000n,
} as const;
export type GasPreset = keyof typeof GAS_PRESETS;
export const GAS_PRESET_KEYS = Object.keys(GAS_PRESETS) as GasPreset[];

export interface GasQuote {
  chain: string;
  chainId: number;
  gasPriceGwei: number;
  gasUnits: number;
  /** What this costs, in USDC dollars. Arc pays gas in USDC. */
  costUsdc: number;
  basis: string;
  presets: Record<string, number>;
  nativeDecimals: number;
  erc20Decimals: number;
  source: string;
}

/**
 * Convert wei-scaled gas into USDC dollars.
 *
 * THE ARC TRAP: the native unit is 18 decimals; the USDC ERC-20 reports 6. A quote that divides
 * by 1e6 is off by a factor of 10^12. This function is the single place that conversion happens.
 */
export function weiToUsdc(wei: bigint): number {
  return Number(wei) / 10 ** NATIVE_DECIMALS;
}

export function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

export async function getGasQuote(
  opts: { gasUnits?: number; preset?: GasPreset; to?: string; from?: string; data?: string } = {},
  env?: Record<string, string | undefined>,
): Promise<GasQuote> {
  const spec = CHAINS.arc;

  const wantEstimate = Boolean(opts.to);
  const calls: Array<{ method: string; params: unknown[] }> = [
    { method: "eth_gasPrice", params: [] },
  ];
  if (wantEstimate) {
    const tx: Record<string, string> = { to: assertAddress(opts.to as string, "to") };
    if (opts.from) tx.from = assertAddress(opts.from, "from");
    if (opts.data) tx.data = opts.data;
    calls.push({ method: "eth_estimateGas", params: [tx] });
  }

  const [gasRaw, estRaw] = await rpcBatch("arc", calls, env);
  const gasPriceWei = hexToBigInt(gasRaw);
  if (gasPriceWei === null) {
    throw new UpstreamError(`${spec.name} RPC`, "gas price was not readable on any provider");
  }

  let gasUnits: bigint;
  let basis: string;
  const estimated = hexToBigInt(estRaw ?? null);
  if (wantEstimate && estimated !== null) {
    gasUnits = estimated;
    basis = "eth_estimateGas for the supplied transaction";
  } else if (wantEstimate) {
    // Asked for an estimate and could not get one: do not silently substitute a guess.
    throw new UpstreamError(
      `${spec.name} RPC`,
      "eth_estimateGas failed for the supplied transaction (it may revert)",
    );
  } else if (opts.gasUnits !== undefined) {
    gasUnits = BigInt(Math.max(0, Math.floor(opts.gasUnits)));
    basis = "caller-supplied gasUnits";
  } else {
    const preset = opts.preset ?? "transfer";
    gasUnits = GAS_PRESETS[preset];
    basis = `preset "${preset}"`;
  }

  const presets: Record<string, number> = {};
  for (const [k, v] of Object.entries(GAS_PRESETS)) {
    presets[k] = round9(weiToUsdc(gasPriceWei * v));
  }

  return {
    chain: spec.name,
    chainId: spec.id,
    gasPriceGwei: Number(gasPriceWei) / 1e9,
    gasUnits: Number(gasUnits),
    costUsdc: round9(weiToUsdc(gasPriceWei * gasUnits)),
    basis,
    presets,
    nativeDecimals: NATIVE_DECIMALS,
    erc20Decimals: 6,
    source: `Live eth_gasPrice on ${spec.name}`,
  };
}

const DESCRIPTION = `What a transaction costs on Arc, priced in USDC dollars.

Arc pays gas in USDC, so a gas quote is directly a dollar figure — no native-token price lookup, no volatility. This tool does that conversion correctly, which is less trivial than it sounds: Arc's native gas unit is 18 decimals while the USDC ERC-20 at 0x3600...0000 reports 6, so a naive conversion is wrong by a factor of 10^12.

Give it nothing and you get the cost of a plain transfer plus a table of common presets. Give it a "to" address (optionally with "from" and "data") and it runs eth_estimateGas against the live chain for that exact transaction.

When to use: budgeting an agent's spend in dollars, deciding whether an action is worth its fee, or estimating a specific call before submitting it.

When NOT to use: you want an EIP-1559 base-fee/priority-fee breakdown rather than a single gas price.

Args:
  - preset (string, optional): one of transfer, erc20Transfer, swap, deploy. Default "transfer".
  - gasUnits (number, optional): exact gas units, overriding the preset.
  - to (string, optional): if set, eth_estimateGas is used instead of a preset.
  - from (string, optional): sender for the estimate.
  - data (string, optional): calldata for the estimate.

Returns structuredContent:
  {
    "chain": "Arc", "chainId": 5042,
    "gasPriceGwei": 20, "gasUnits": 21000, "costUsdc": 0.00042,
    "basis": "preset \\"transfer\\"",
    "presets": { "transfer": 0.00042, "erc20Transfer": 0.0013, "swap": 0.003, "deploy": 0.01 },
    "nativeDecimals": 18, "erc20Decimals": 6
  }

If "to" is supplied and eth_estimateGas fails (for example the transaction would revert), the call ERRORS rather than falling back to a preset — and an errored call is never billed.`;

export const arcGasQuoteTool: ToolModule = {
  name: TOOL_NAME,
  title: "Arc Gas Quote (USDC)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", description: "transfer | erc20Transfer | swap | deploy" },
        gasUnits: { type: "number", description: "Exact gas units, overriding the preset." },
        to: { type: "string", description: "Estimate gas for a transaction to this address." },
        from: { type: "string" },
        data: { type: "string" },
      },
    },
    inputExample: { preset: "swap" },
    output: {
      example: { chain: "Arc", chainId: 5042, gasPriceGwei: 20, gasUnits: 21000, costUsdc: 0.00042 },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Arc Gas Quote (USDC)",
        description: DESCRIPTION,
        inputSchema: {
          preset: z.enum(GAS_PRESET_KEYS as [GasPreset, ...GasPreset[]]).optional(),
          gasUnits: z.number().int().positive().optional(),
          to: z.string().optional(),
          from: z.string().optional(),
          data: z.string().optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        const result = await getGasQuote(
          args,
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
