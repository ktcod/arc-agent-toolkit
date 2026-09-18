#!/usr/bin/env node
/**
 * One-time setup for a BUYER: deposit USDC into the Circle Gateway Wallet on Arc.
 *
 * A Gateway balance is not a plain transfer. The deposit approves the GatewayWallet contract
 * and calls deposit(), so Gateway credits YOU as the depositor. Sending USDC to the contract
 * address directly would not create a spendable balance.
 *
 * After this, individual payments are gasless: the buyer signs EIP-3009 authorizations offchain
 * and Gateway settles net positions in batches.
 *
 * YOUR KEY STAYS ON YOUR MACHINE. It is read from the environment, used by viem locally to sign,
 * and never written to disk or sent anywhere except as a signature.
 *
 * Usage:
 *   node scripts/fund-gateway.mjs 0.50           # prompts for the key, hidden input
 *   CHAIN=arcTestnet node scripts/fund-gateway.mjs 1
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { resolvePrivateKey } from "./lib/prompt-key.mjs";

const amount = process.argv[2] || "0.50";
const chain = process.env.CHAIN || "arc";
let privateKey;
try {
  privateKey = await resolvePrivateKey("BUYER_PRIVATE_KEY");
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}

const client = new GatewayClient({ chain, privateKey });

console.log(`chain  : ${chain}`);
console.log(`amount : ${amount} USDC`);
console.log("depositing (approve + deposit; this costs a little gas, paid in USDC)...\n");

const result = await client.deposit(amount);
console.log("deposited.");
if (result.approvalTxHash) console.log(`  approval tx: ${result.approvalTxHash}`);
console.log(`  deposit tx : ${result.depositTxHash}`);
console.log(`  amount     : ${result.formattedAmount} USDC`);
console.log(`  depositor  : ${result.depositor}`);

const balances = await client.getBalances();
console.log("\nbalances now:", JSON.stringify(balances, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("\nNext: node scripts/pay-http.mjs arc_gas_quote");
