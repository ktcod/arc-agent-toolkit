# Verification

Every Arc-specific claim this server makes was checked against the live chain or a published
spec before shipping, not assumed from documentation. This file records what was checked, what
it returned, and what would have gone wrong without the check.

All checks run 2026-09-18 against Arc mainnet (chain 5042).

---

## 1. Gas is USDC at 18 decimals; the USDC ERC-20 reports 6

**The trap.** Arc pays gas in USDC. The obvious inference is that gas amounts are 6-decimal USDC
amounts. They are not: the native unit is wei-scaled at 18 decimals, while the ERC-20 at
`0x3600000000000000000000000000000000000000` reports `decimals() == 6`.

**Checked.**

```
eth_gasPrice                            -> 0x4a817d33c   (20000002876 wei = 20.000002876 gwei)
eth_call decimals() @ 0x3600…0000       -> 0x06
eth_getBalance (a funded account)        -> an 18-decimal quantity
```

**Consequence.** A gas quote that divides by `1e6` instead of `1e18` is wrong by a factor of
10^12: it would price a $0.00042 transfer at $420,000,000. `weiToUsdc` in
`src/tools/arcGasQuote.ts` is the single place this conversion happens, and
`test/arcGasQuote.test.ts` asserts the exact observed value and the size of the error.

## 2. A plain transfer costs 21,000 gas

**Checked.** `eth_estimateGas` for a bare value transfer returned `0x5208` = 21000.

**Consequence.** The `transfer` preset is measured, not guessed. 21000 × 20000002876 wei =
0.000420000060396 USDC, pinned in the tests.

## 3. Arc supports the `safe` and `finalized` block tags

**Checked.** `eth_getBlockByNumber` returned full headers for both `safe` and `finalized`, with
`safe` trailing `finalized` by one block at the time of the check.

**Consequence.** `arc_tx_finality` reports a deterministic finality state rather than a
confirmation count. Without this, the honest answer would have been "N confirmations, make your
own judgement", which is exactly the probabilistic reasoning Arc is built to remove. The tool
still degrades correctly: when a node exposes neither tag, it reports `included` rather than
claiming a finality it cannot prove (`test/arcTxFinality.test.ts`).

## 4. `eth_getLogs` is capped at 10,000 blocks

**Checked.** A 2,000-block query succeeded. Wider ranges return:

```
{"code":35,"message":"ranges over 10000 blocks are not supported on free plan"}
```

**Consequence.** No tool may depend on wide log scans. This is why the settlement monitor reads
Circle Gateway's transfers API rather than reconstructing history from `Transfer` events.

## 5. Circle Gateway supports Arc mainnet for x402 settlement

**Checked.** `GET https://gateway-api.circle.com/v1/x402/supported` lists:

```json
{ "x402Version": 2, "scheme": "exact", "network": "eip155:5042",
  "extra": { "name": "GatewayWalletBatched", "version": "1",
             "verifyingContract": "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
             "assets": [{ "symbol": "USDC",
                          "address": "0x3600000000000000000000000000000000000000",
                          "decimals": 6 }] } }
```

**Consequence.** Mainnet settlement is real, not testnet-only. Circle's own seller quickstart
only demonstrates Arc **Testnet** (`eip155:5042002`), so this had to be confirmed directly
rather than inferred from the docs.

## 6. Gateway's read endpoints need no API key

**Checked.** In `developers.circle.com/openapi/gateway.yaml`, `/v1/x402/settle`,
`/v1/x402/verify`, `/v1/x402/supported`, `/v1/x402/transfers` and `/v1/balances` all carry an
empty security array. Only the `/v2/notifications/**` webhook paths require Bearer auth.

**Consequence.** The settlement monitor needs no key, no secret, and no database. This is why
the whole service is stateless.

## 7. `GatewayEvmScheme` is required, not optional

**Checked.** Read from the shipped type declarations of `@circle-fin/x402-batching@3.5.0`:

> The base `ExactEvmScheme.enhancePaymentRequirements` returns requirements unchanged, dropping
> `supportedKind.extra`. Gateway payments require `extra.verifyingContract` … to be present for
> clients to construct the correct signing domain.

**Consequence.** Registering the plain `ExactEvmScheme` would produce 402 challenges that look
correct and that **every buyer fails to pay**, because they would sign against the wrong EIP-712
domain. The failure mode is silent at the server. `src/payments/x402.ts` registers
`GatewayEvmScheme` and says why.

## 8. StableFX is a stub on Arc mainnet

**Checked.** `explorer.arc.io` shows the FxEscrow at
`0xe2E5F173576B513d994073CCbDaCBE027d43DFe6` with verified source `contracts/StubContract.sol`.

**Consequence.** A planned sixth tool, `arc_fx_activity`, was **cut** rather than shipped
against a stub. It is on the roadmap for when StableFX mainnet is live. Shipping a tool that
reads a placeholder contract and reports confident-looking results would have been the easy
thing and the wrong one.

## 9. Canonical-asset impersonation is already happening on Arc

**Checked.** DexScreener indexes Arc as `chainId: "arc"`. A search returned, among others:

| Symbol | Address | Liquidity |
|---|---|---|
| `USDCARC` | `0xaaC788737179Cd696d19b1A09c5392033C9127A6` | ~$2,481 |

against genuine USDC at `0x3600000000000000000000000000000000000000`.

**Consequence.** This is the concrete case `arc_asset_verify` exists for, and it is used as a
fixture in both `test/arcAssetVerify.ts` and the Foundry test for the registry contract, so the
real impersonator must keep reading as non-canonical for the suite to pass.

## 10. Blockscout's API is not reachable from a server

**Checked.** `curl` against `explorer.arc.io/api/v2/...` returns a Cloudflare interstitial
(HTTP 403), including for canonical USDC. A browser reaches the same URL fine.

**Consequence.** No runtime dependency on the explorer API. Explorer links are rendered for
humans, but nothing this server needs is fetched from it. It also means `forge verify-contract`
may fail and the registry may need verifying through the explorer UI instead.

---

## What is not verified

- **No live paid-call conformance run yet.** The source project this was forked from ships a
  conformance suite of real paid calls against production. That harness has not been ported, and
  claiming its results here would be a lie. It is the top roadmap item.
- **Tool outputs are checked against fixtures and live reads, but the service has limited
  production traffic.** The settlement monitor shows exactly what has been paid, including zero,
  and deliberately distinguishes "nothing yet" from "could not read".
