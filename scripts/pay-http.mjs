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
 *   node scripts/pay-http.mjs                    # prompts for the key, hidden input
 *   node scripts/pay-http.mjs arc_asset_verify '{"address":"0x3600000000000000000000000000000000000000"}'
 *   BASE=https://your-worker.workers.dev node scripts/pay-http.mjs
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { resolvePrivateKey } from "./lib/prompt-key.mjs";

const base = (process.env.BASE || "https://arc-agent-toolkit-prod.ktcod.workers.dev").replace(/\/$/, "");
// arc_gas_quote is joint-cheapest at $0.001 — the least expensive way to trigger a real settle.
const tool = process.argv[2] || "arc_gas_quote";
const rawArgs = process.argv[3] || "{}";
const chain = process.env.CHAIN || "arc";
let privateKey;
try {
  privateKey = await resolvePrivateKey("BUYER_PRIVATE_KEY");
} catch (e) {
  // Surface EVERYTHING. Gateway's useful detail often rides on e.cause or a nested response
  // body rather than e.message, and an empty "Payment failed:" tells you nothing at all.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`NOT SETTLED — ${msg || "(the error carried no message)"}`);

  const seen = new Set();
  const dump = (label, value, depth = 0) => {
    if (value == null || depth > 3 || seen.has(value)) return;
    if (typeof value === "object") seen.add(value);
    if (typeof value === "string" || typeof value === "number") {
      console.error(`  ${label}: ${value}`);
      return;
    }
    if (typeof value !== "object") return;
    for (const key of ["message", "error", "errorReason", "invalidReason", "reason", "code", "status", "statusText", "detail", "details", "body", "data", "response", "cause"]) {
      if (key in value && value[key] != null) dump(`${label}.${key}`, value[key], depth + 1);
    }
  };
  if (e && typeof e === "object") {
    dump("error", e);
    try {
      const flat = JSON.stringify(e, Object.getOwnPropertyNames(e));
      if (flat && flat !== "{}") console.error(`  raw: ${flat.slice(0, 1200)}`);
    } catch {}
  }

  if (/insufficient_balance/i.test(msg)) {
    console.error("\nNo Gateway balance. Run: node scripts/fund-gateway.mjs 0.50");
  } else if (/invalid_signature/i.test(msg)) {
    console.error("\ninvalid_signature with a correct key means the EIP-712 domain is wrong.");
    console.error("Check the server registers GatewayEvmScheme, not the base ExactEvmScheme.");
  } else {
    console.error("\nIf the payer address equals the seller's payTo address, Gateway may be");
    console.error("refusing a self-payment. Try a separate buyer wallet.");
    console.error("Server health is independently checkable with: node scripts/diagnose-paywall.mjs");
  }
  process.exit(1);
}
