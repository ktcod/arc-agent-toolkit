import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import { CHAINS, hexToBigInt, rpcBatchRaw, type BlockHeader } from "../upstream/evm.js";

export const TOOL_NAME = "arc_tx_finality";
export const TOOL_PRICE = "$0.001";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Finality states, weakest to strongest.
 *  unknown   — the node has never seen this hash
 *  pending   — seen in the mempool, not yet in a block
 *  included  — in a block, but that block is not yet safe
 *  safe      — at or below the `safe` head
 *  finalized — at or below the `finalized` head; irreversible
 */
export type Finality = "unknown" | "pending" | "included" | "safe" | "finalized";

export interface FinalityResult {
  txHash: string;
  finality: Finality;
  succeeded: boolean | null;
  blockNumber: number | null;
  confirmations: number | null;
  latestBlock: number | null;
  safeBlock: number | null;
  finalizedBlock: number | null;
  gasUsed: number | null;
  explorerUrl: string | null;
  source: string;
}

interface Receipt {
  blockNumber?: string;
  status?: string;
  gasUsed?: string;
}

export function readBlockNumber(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const n = hexToBigInt((v as BlockHeader).number);
  return n === null ? null : Number(n);
}

/** Classify a transaction against the three chain heads. Pure, so it is directly testable. */
export function classify(
  receiptBlock: number | null,
  seenInMempool: boolean,
  heads: { latest: number | null; safe: number | null; finalized: number | null },
): Finality {
  if (receiptBlock === null) return seenInMempool ? "pending" : "unknown";
  if (heads.finalized !== null && receiptBlock <= heads.finalized) return "finalized";
  if (heads.safe !== null && receiptBlock <= heads.safe) return "safe";
  return "included";
}

export async function getFinality(
  txHash: string,
  env?: Record<string, string | undefined>,
): Promise<FinalityResult> {
  const hash = txHash.trim();
  if (!TX_HASH_RE.test(hash)) {
    throw new UpstreamError("Arc", `not a valid transaction hash: "${hash.slice(0, 12)}…"`);
  }
  const spec = CHAINS.arc;

  const [receiptRaw, txRaw, latestRaw, safeRaw, finalizedRaw] = await rpcBatchRaw(
    "arc",
    [
      { method: "eth_getTransactionReceipt", params: [hash] },
      { method: "eth_getTransactionByHash", params: [hash] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_getBlockByNumber", params: ["safe", false] },
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
    ],
    env,
  );

  const latest = readBlockNumber(latestRaw);
  if (latest === null) {
    throw new UpstreamError(`${spec.name} RPC`, "latest block was not readable on any provider");
  }

  const receipt = (receiptRaw ?? null) as Receipt | null;
  const receiptBlockBig = hexToBigInt(receipt?.blockNumber);
  const receiptBlock = receiptBlockBig === null ? null : Number(receiptBlockBig);
  const heads = { latest, safe: readBlockNumber(safeRaw), finalized: readBlockNumber(finalizedRaw) };
  const finality = classify(receiptBlock, txRaw !== null && txRaw !== undefined, heads);

  const statusBig = hexToBigInt(receipt?.status);
  const gasUsedBig = hexToBigInt(receipt?.gasUsed);

  return {
    txHash: hash,
    finality,
    succeeded: statusBig === null ? null : statusBig === 1n,
    blockNumber: receiptBlock,
    confirmations: receiptBlock === null ? null : Math.max(0, latest - receiptBlock),
    latestBlock: heads.latest,
    safeBlock: heads.safe,
    finalizedBlock: heads.finalized,
    gasUsed: gasUsedBig === null ? null : Number(gasUsedBig),
    explorerUrl: finality === "unknown" ? null : `${spec.explorer}/tx/${hash}`,
    source: `Live RPC on ${spec.name}`,
  };
}

const DESCRIPTION = `Is this Arc transaction final yet? Returns a deterministic finality state, not a confirmation-count guess.

Arc offers deterministic finality with a permissioned validator set, and its RPCs expose the "safe" and "finalized" block tags (verified 2026-09-18). That means an agent can know a transaction is irreversible rather than inferring it from N confirmations, which is the right primitive for settlement.

States, weakest to strongest: unknown (node has never seen it), pending (in the mempool), included (in a block that is not yet safe), safe, finalized (irreversible).

When to use: before treating a payment or swap as done; deciding whether to retry; reconciling agent-initiated transfers.

When NOT to use: you want the transaction's decoded contents or logs.

Args:
  - txHash (string, required): 0x-prefixed 32-byte transaction hash.

Returns structuredContent:
  {
    "txHash": "0x...", "finality": "finalized", "succeeded": true,
    "blockNumber": 21561400, "confirmations": 62,
    "latestBlock": 21561462, "safeBlock": 21561460, "finalizedBlock": 21561461,
    "gasUsed": 21000, "explorerUrl": "https://explorer.arc.io/tx/0x..."
  }

"succeeded" is null when there is no receipt yet. A transaction the node has never seen returns finality "unknown" rather than an error, because not-yet-broadcast and invalid are different facts.`;

export const arcTxFinalityTool: ToolModule = {
  name: TOOL_NAME,
  title: "Arc Transaction Finality",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: { txHash: { type: "string", description: "0x-prefixed 32-byte tx hash." } },
      required: ["txHash"],
    },
    inputExample: {
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    output: { example: { txHash: "0x…", finality: "finalized", confirmations: 62 } },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Arc Transaction Finality",
        description: DESCRIPTION,
        inputSchema: { txHash: z.string().describe("0x-prefixed 32-byte transaction hash.") },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ txHash }) => {
        const result = await getFinality(
          txHash,
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
