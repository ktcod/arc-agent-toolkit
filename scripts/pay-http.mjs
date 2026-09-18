#!/usr/bin/env node
/**
 * Buyer-side client: pay for one tool call with USDC on Arc, via Circle Nanopayments.
 *
 * Requires a Gateway balance first — run scripts/fund-gateway.mjs once.
 *
 * WHY THIS USES GatewayClient AND NOT THE STANDARD x402 CLIENT: Circle's batched scheme signs
 * the EIP-3009 authorization against the GatewayWallet contract taken from
 * extra.verifyingContract, NOT against the USDC token contract. The stock
 * registerExactEvmScheme signs against the token and produces a signature Gateway rejects as
 * invalid_signature. The failure is confusing because the 402 challenge looks perfectly fine.
 *
 * YOUR KEY STAYS ON YOUR MACHINE. Only an EIP-3009 signature leaves it, and payments are gasless.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x... node scripts/pay-http.mjs
 *   BUYER_PRIVATE_KEY=0x... node scripts/pay-http.mjs arc_asset_verify '{"address":"0x3600000000000000000000000000000000000000"}'
 *   BASE=https://your-worker.workers.dev BUYER_PRIVATE_KEY=0x... node scripts/pay-http.mjs
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";

const base = (process.env.BASE || "https://arc-agent-toolkit-prod.ktcod.workers.dev").replace(/\/$/, "");
// arc_gas_quote is joint-cheapest at $0.001 — the least expensive way to trigger a real settle.
const tool = process.argv[2] || "arc_gas_quote";
const rawArgs = process.argv[3] || "{}";
const chain = process.env.CHAIN || "arc";
const privateKey = process.env.BUYER_PRIVATE_KEY;

if (!privateKey) {
  console.error(
    "ERROR: set BUYER_PRIVATE_KEY=0x... (a wallet with a Gateway balance on Arc).\n" +
      "Run scripts/fund-gateway.mjs first. The key stays local; only a signature is sent.",
  );
  process.exit(1);
}

let body;
try {
  body = JSON.parse(rawArgs);
} catch {
  console.error(`ERROR: arguments must be valid JSON. Got: ${rawArgs}`);
  process.exit(1);
}

const url = `${base}/x402/${tool}`;
const client = new GatewayClient({ chain, privateKey });

console.error(`endpoint : ${url}`);
console.error(`args     : ${JSON.stringify(body)}`);
console.error("paying on the 402...\n");

try {
  const result = await client.pay(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
  console.error(`HTTP ${result.status}`);
  console.error(`paid        : ${result.formattedAmount} USDC`);
  console.error(`settlement  : ${result.transaction}`);
  console.error("\nIt should now appear at " + base + "/monitor");
  console.log("\nResult:");
  console.log(JSON.stringify(result.data, null, 2));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("NOT SETTLED —", msg);
  if (/insufficient_balance/i.test(msg)) {
    console.error("\nNo Gateway balance. Run: BUYER_PRIVATE_KEY=0x... node scripts/fund-gateway.mjs 0.50");
  } else if (/invalid_signature/i.test(msg)) {
    console.error("\ninvalid_signature with a correct key means the EIP-712 domain is wrong.");
    console.error("Check the server registers GatewayEvmScheme, not the base ExactEvmScheme.");
  }
  process.exit(1);
}
