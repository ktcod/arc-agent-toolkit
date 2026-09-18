#!/usr/bin/env node
/**
 * Buyer-side client: pay for one tool call with USDC on Arc, via Circle Nanopayments.
 *
 * Requires a Gateway balance first — run scripts/fund-gateway.mjs once.
 *
 * WHY THIS DRIVES BatchEvmScheme DIRECTLY INSTEAD OF CALLING GatewayClient.pay():
 *
 *   1. Circle's batched scheme signs the EIP-3009 authorization against the GatewayWallet
 *      contract from extra.verifyingContract, NOT against the USDC token contract. The stock
 *      @x402/evm registerExactEvmScheme signs against the token, and Gateway rejects the result
 *      as invalid_signature while the 402 challenge still looks perfectly fine.
 *
 *   2. GatewayClient.pay() reports failures uselessly. It does:
 *          const error = await paidResponse.json().catch(() => ({}));
 *          throw new Error(`Payment failed: ${error.error || paidResponse.statusText}`);
 *      looking for the reason in the response BODY. An x402 server returns it in the
 *      `payment-required` RESPONSE HEADER, and statusText is empty over HTTP/2 (which
 *      Cloudflare Workers serve), so both fall back to nothing and you get a bare
 *      "Payment failed: " with no reason at all. Driving the scheme ourselves means we read the
 *      header and can say insufficient_balance or invalid_signature, which is the whole
 *      difference between a fixable problem and a mystery.
 *
 * YOUR KEY STAYS ON YOUR MACHINE. Only an EIP-3009 signature leaves it, and payments are gasless.
 *
 * Usage:
 *   node scripts/pay-http.mjs                    # prompts for the key, hidden input
 *   node scripts/pay-http.mjs arc_asset_verify '{"address":"0x3600000000000000000000000000000000000000"}'
 *   BASE=https://your-worker.workers.dev node scripts/pay-http.mjs
 */
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { resolvePrivateKey } from "./lib/prompt-key.mjs";

const base = (process.env.BASE || "https://arc-agent-toolkit-prod.ktcod.workers.dev").replace(/\/$/, "");
// arc_gas_quote is joint-cheapest at $0.001 — the least expensive way to trigger a real settle.
const tool = process.argv[2] || "arc_gas_quote";
const rawArgs = process.argv[3] || "{}";

let body;
try {
  body = JSON.parse(rawArgs);
} catch {
  console.error(`ERROR: arguments must be valid JSON. Got: ${rawArgs}`);
  process.exit(1);
}

let privateKey;
try {
  privateKey = await resolvePrivateKey("BUYER_PRIVATE_KEY");
} catch (e) {
  console.error("ERROR:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const url = `${base}/x402/${tool}`;
const payload = JSON.stringify(body);

console.error(`endpoint : ${url}`);
console.error(`payer    : ${account.address}`);
console.error(`args     : ${payload}`);

/** Pull the x402 error reason out of a `payment-required` header, or null if absent. */
function reasonFrom(response) {
  const header = response.headers.get("payment-required");
  if (!header) return null;
  try {
    const padded = header + "=".repeat(((-header.length % 4) + 4) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")).error ?? null;
  } catch {
    return null;
  }
}

// Step 1: get the challenge.
const challengeRes = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: payload,
});
if (challengeRes.status !== 402) {
  console.error(`\nExpected HTTP 402 from the paywall, got ${challengeRes.status}.`);
  console.error(await challengeRes.text().catch(() => ""));
  process.exit(1);
}
const challengeHeader = challengeRes.headers.get("payment-required");
if (!challengeHeader) {
  console.error("\n402 carried no payment-required header. The server is misconfigured.");
  process.exit(1);
}
const challenge = decodePaymentRequiredHeader(challengeHeader);
const requirements = challenge.accepts[0];

console.error(`payTo    : ${requirements.payTo}`);
console.error(`price    : ${Number(requirements.amount) / 1e6} USDC`);
const selfPayment = requirements.payTo?.toLowerCase() === account.address.toLowerCase();
if (selfPayment) {
  console.error("\nNOTE: payer and payTo are the SAME address (a self-payment).");
}

// Step 2: sign against the GatewayWallet domain the challenge names.
console.error("\npaying on the 402...\n");
let signed;
try {
  signed = await new BatchEvmScheme({
    address: account.address,
    signTypedData: (args) => account.signTypedData(args),
  }).createPaymentPayload(challenge.x402Version ?? 2, requirements);
} catch (e) {
  console.error("NOT SETTLED — could not sign the payment authorization.");
  console.error(`  ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Step 3: retry with the signature attached.
const paidRes = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "payment-signature": encodePaymentSignatureHeader({
      ...signed,
      resource: challenge.resource,
      accepted: requirements,
    }),
  },
  body: payload,
});

if (paidRes.ok) {
  const receiptHeader = paidRes.headers.get("payment-response");
  let receipt = null;
  if (receiptHeader) {
    try {
      const padded = receiptHeader + "=".repeat(((-receiptHeader.length % 4) + 4) % 4);
      receipt = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      /* a malformed receipt does not invalidate a successful call */
    }
  }
  console.error(`HTTP ${paidRes.status}`);
  console.error(`paid       : ${Number(requirements.amount) / 1e6} USDC`);
  if (receipt?.transaction) console.error(`settlement : ${receipt.transaction}`);
  if (receipt?.network) console.error(`network    : ${receipt.network}`);
  console.error(`\nIt should now appear at ${base}/monitor`);
  console.log("\nResult:");
  console.log(await paidRes.text());
  process.exit(0);
}

const reason = reasonFrom(paidRes);
console.error(`NOT SETTLED — HTTP ${paidRes.status}, reason: ${reason ?? "(none reported)"}`);

if (reason === "insufficient_balance") {
  console.error("\nThis payer has no Gateway balance on Arc. Fund it with:");
  console.error("  node scripts/fund-gateway.mjs 0.50");
  console.error("Note the balance belongs to the PAYER address shown above, not to payTo.");
} else if (reason === "invalid_signature") {
  console.error("\nThe EIP-712 domain is wrong. Check the server registers GatewayEvmScheme");
  console.error("rather than the base ExactEvmScheme, which drops extra.verifyingContract.");
} else if (selfPayment) {
  console.error("\nPayer and payTo are the same address. Try a separate buyer wallet.");
} else {
  console.error("\nServer health is independently checkable, with no key and no funds:");
  console.error("  node scripts/diagnose-paywall.mjs");
}
process.exit(1);
