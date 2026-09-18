#!/usr/bin/env node
/**
 * Prove the paywall works — without a funded wallet and without spending anything.
 *
 * Generates an EPHEMERAL, zero-balance key, signs a real payment authorization against the live
 * service, and reads Circle Gateway's verdict. The key is created in memory, used once, and never
 * written anywhere.
 *
 * The trick is that Gateway's rejection reason is itself the diagnostic:
 *
 *   valid signature, no funds -> "insufficient_balance"  -> signature and EIP-712 domain CORRECT
 *   corrupted signature       -> "invalid_signature"     -> Gateway really is verifying
 *
 * Seeing those two different errors proves the whole path is sound and only funding is absent.
 * If a valid signature returns "invalid_signature", the EIP-712 domain is wrong — almost always
 * because the server registered the base ExactEvmScheme instead of Circle's GatewayEvmScheme,
 * which drops extra.verifyingContract (see VERIFICATION.md).
 *
 * Usage:
 *   node scripts/diagnose-paywall.mjs [tool]
 *   BASE=https://your-worker.workers.dev node scripts/diagnose-paywall.mjs
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";

const base = (process.env.BASE || "https://arc-agent-toolkit-prod.ktcod.workers.dev").replace(/\/$/, "");
const tool = process.argv[2] || "arc_gas_quote";
const url = `${base}/x402/${tool}`;

const account = privateKeyToAccount(generatePrivateKey());
console.log(`endpoint       : ${url}`);
console.log(`ephemeral payer: ${account.address}  (generated now, zero balance, never stored)\n`);

const challengeRes = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (challengeRes.status !== 402) {
  console.error(`FAIL: expected HTTP 402, got ${challengeRes.status}. The paywall is not engaging.`);
  process.exit(1);
}
const header = challengeRes.headers.get("payment-required");
if (!header) {
  console.error("FAIL: 402 carried no payment-required header.");
  process.exit(1);
}
const challenge = decodePaymentRequiredHeader(header);
const reqs = challenge.accepts[0];

console.log("402 challenge");
console.log(`  network          : ${reqs.network}`);
console.log(`  asset            : ${reqs.asset}`);
console.log(`  amount           : ${reqs.amount} (atomic, 6dp = $${Number(reqs.amount) / 1e6})`);
console.log(`  payTo            : ${reqs.payTo}`);
console.log(`  scheme name      : ${reqs.extra?.name}`);
console.log(`  verifyingContract: ${reqs.extra?.verifyingContract}`);

if (!reqs.extra?.verifyingContract) {
  console.error("\nFAIL: no extra.verifyingContract. Buyers cannot build the EIP-712 domain.");
  console.error("The server is registering the base ExactEvmScheme instead of GatewayEvmScheme.");
  process.exit(1);
}

const scheme = new BatchEvmScheme({
  address: account.address,
  signTypedData: (args) => account.signTypedData(args),
});
const payload = await scheme.createPaymentPayload(challenge.x402Version ?? 2, reqs);

async function attempt(payloadToSend) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": encodePaymentSignatureHeader({
        ...payloadToSend,
        resource: challenge.resource,
        accepted: reqs,
      }),
    },
    body: "{}",
  });
  const again = res.headers.get("payment-required");
  if (!again) return { status: res.status, error: null };
  try {
    return { status: res.status, error: JSON.parse(Buffer.from(again, "base64").toString("utf8")).error };
  } catch {
    return { status: res.status, error: "(undecodable)" };
  }
}

const good = await attempt(payload);

// Flip one character inside the 65-byte signature, leaving everything else intact.
const corrupted = structuredClone(payload);
const locate = (o) => {
  for (const k of Object.keys(o)) {
    if (typeof o[k] === "string" && /^0x[0-9a-f]{130}$/i.test(o[k])) return [o, k];
    if (o[k] && typeof o[k] === "object") {
      const found = locate(o[k]);
      if (found) return found;
    }
  }
  return null;
};
const hit = locate(corrupted);
let bad = null;
if (hit) {
  const [obj, key] = hit;
  obj[key] = obj[key].slice(0, 20) + (obj[key][20] === "a" ? "b" : "a") + obj[key].slice(21);
  bad = await attempt(corrupted);
}

console.log("\nGateway verdicts");
console.log(`  valid signature    : HTTP ${good.status}  ${good.error ?? "SETTLED"}`);
if (bad) console.log(`  corrupted signature: HTTP ${bad.status}  ${bad.error}`);

const healthy = good.error === "insufficient_balance" && (!bad || bad.error === "invalid_signature");
const settled = good.error === null;

console.log();
if (settled) {
  console.log("PASS — the payment actually settled. (This wallet had funds; it was not meant to.)");
} else if (healthy) {
  console.log("PASS — the paywall is correct end to end.");
  console.log("  Gateway verified the signature and the EIP-712 domain, and rejected only for");
  console.log("  lack of funds. A corrupted signature returns a different error, which proves");
  console.log("  verification is genuinely happening rather than being skipped.");
  console.log("  To settle for real, fund a buyer's Gateway balance and use scripts/pay-http.mjs.");
} else {
  console.log(`FAIL — unexpected verdict: ${good.error}`);
  console.log("  'invalid_signature' on a VALID signature means the EIP-712 domain is wrong.");
  process.exit(1);
}
