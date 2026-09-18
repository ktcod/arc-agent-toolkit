# Arc Agent Toolkit — Design

**Date:** 2026-09-18
**Status:** Approved, in implementation
**Context:** Personal / Agent Fund Ventures
**Target:** [Arc Microgrants](https://dorahacks.io/hackathon/arc-microgrants/detail) — 20 × 500 USDC,
submissions close 2026-10-14 23:59 ET, rolling review. **Submitting 2026-09-18.**

## 1. What this is

A pay-per-call MCP server that gives AI agents Arc-native data, priced in USDC and settled on
**Arc mainnet** through **Circle Nanopayments** (Circle Gateway's batched x402).

Five tools, one small verified registry contract, a live settlement monitor, and a public
verification ledger.

### What it is not

Not a token-safety oracle. That was the original direction and it was dropped after verification:
GoPlus already lists Arc (chain 5042) among its 46 supported chains, so the category has an
incumbent with a coverage backlog, not an opening. `arc_asset_verify` survives as **one tool of
five**, scoped to canonical-Circle-asset impersonation, which is Arc-specific and narrow enough
to be defensible.

See the June 2026 conclusion recorded in `agentnet-x402-relaunch`: the paid-safety category is
crowded and demand is thin. This design does not re-enter it.

## 2. Why this shape fits the rubric

The published criteria are relevance to Arc, technical credibility, quality of what was built,
and whether it is worth taking further, with "promise counts for more than traction".

| Rubric item | How this answers it |
|---|---|
| Relevance to Arc | Every tool is about Arc, paid on Arc, in Arc's own gas asset, through Circle's own rail |
| Technical credibility | Fork of a working, tested x402 server; public verification ledger of live-checked facts |
| Quality | Money-safety invariant (a failed call is never billed) carried over and tested |
| Worth taking further | Directly the "agentic economy" frontier from Circle's own Request for Builders |

Eligibility is satisfied unambiguously: a **live deployment on Arc mainnet** (the Worker plus a
verified on-chain contract), a **public repo**, a description, and a public builder profile.

## 3. Repository and identity

- Repo: `github.com/ktcod/arc-agent-toolkit`, **public**.
- Local path `~/code/personal/arc-agent-toolkit`, so `~/.gitconfig` `includeIf` yields the
  `ktcod` commit identity (verified: `Kenneth Ta <170149659+ktcod@users.noreply.github.com>`).

> **Deliberate exception.** The standing personal convention is per-project **private** repos.
> The microgrant requires a public repo, so this one is public by design. Nothing secret may
> enter it. The inherited `resolvePayoutAddress` guard, which refuses anything shaped like a
> private key, is retained and is now load-bearing.

## 4. Architecture

Seeded from the proven `x402-json-repair-mcp` skeleton, tools and tests removed. Carried over
unchanged because they are already correct and tested:

- Hono on Cloudflare Workers, with a Node entrypoint sharing one module graph.
- `PaymentGate.chargeAndRun` as the **single** money path for both `/mcp` and `/x402/<tool>`, so
  money-safety rules cannot drift between the two surfaces.
- **A failed call is never billed.** The MCP SDK turns a thrown tool error into HTTP 200 with
  `isError: true`; the gate inspects the result and returns errors *unsettled*.
- The `ToolModule` contract: one file per tool, registered in `src/tools/index.ts`, which stays
  the only file that changes when a tool is added.
- Multi-provider RPC rotation, throwing only when every provider fails.
- `scripts/gen-docs.mjs` embedding Markdown into the bundle (Workers has no filesystem), with a
  drift test.
- Two-environment `wrangler.toml` (sandbox / production).

### Two swaps, and only two

| Layer | Source repo (Base) | This repo (Arc) |
|---|---|---|
| Facilitator | `HTTPFacilitatorClient` / Coinbase CDP | `BatchFacilitatorClient` from `@circle-fin/x402-batching/server` |
| Scheme | `registerExactEvmScheme` | `.register("eip155:5042", new GatewayEvmScheme())` |

Both satisfy the existing `ResourceServerLike` interface that `buildPaymentGate` constructs and
that the inherited paywall test already fakes, so payment tests port with a changed fixture
rather than a rewrite.

`@circle-fin/x402-batching@3.5.0` peer-depends on `@x402/core ^2.3.0`, `@x402/evm ^2.3.0` and
`viem ^2.0.0`. The source repo runs `@x402/core ^2.15.0` and `@x402/evm ^2.15.0`, which satisfy
those ranges. `viem` is promoted from a dev dependency to a runtime peer.

**Arc only.** No Base support in this repo. A reviewer should not have to look for the Arc part.

### Network configuration

`config.ts` loses its Base-only network guard and accepts exactly two networks:

| | CAIP-2 | Chain ID | Gateway facilitator |
|---|---|---|---|
| Mainnet | `eip155:5042` | 5042 | `https://gateway-api.circle.com` |
| Testnet | `eip155:5042002` | 5042002 | `https://gateway-api-testnet.circle.com` |

Verified live: `GET https://gateway-api.circle.com/v1/x402/supported` lists `eip155:5042` with
`verifyingContract` `0x77777777dcc4d5a8b6e418fd04d8997ef11000ee` and USDC
`0x3600000000000000000000000000000000000000` at 6 decimals.

## 5. Arc facts this design depends on (all verified live 2026-09-18)

Not assumptions. Each is confirmed against mainnet RPC or a published spec, and each becomes an
entry in `VERIFICATION.md`.

1. **Gas is USDC at 18 decimals; the ERC-20 is 6 decimals.** `eth_gasPrice` returns `0x4a817d33c`
   (20 gwei) and native balances are 18-decimal quantities, while `decimals()` on `0x3600…0000`
   returns `6`. A tool that mixes these is wrong by a factor of 10^12. This is the most likely
   bug in any Arc integration and the reason `arc_gas_quote` exists.
2. **A plain transfer costs 21,000 gas**, so ≈ 21000 × 20 gwei = 0.00042 USDC.
3. **`safe` and `finalized` block tags are supported**, with `safe` trailing `finalized` by one
   block at time of check. This makes `arc_tx_finality` meaningful rather than cosmetic.
4. **`eth_getLogs` is capped**: "ranges over 10000 blocks are not supported on free plan". No
   tool may depend on wide log ranges.
5. **DexScreener indexes Arc** (`chainId: "arc"`), which is the liquidity source.
6. **`FxEscrow` at `0xe2E5F173576B513d994073CCbDaCBE027d43DFe6` is a stub.** The explorer shows
   verified source `contracts/StubContract.sol`. StableFX is not live on Arc mainnet, so the FX
   tool is cut from v1 and listed as roadmap.
7. **Circle Gateway's `/v1/x402/transfers`, `/v1/x402/supported` and `/v1/balances` are keyless**
   (empty security array in `developers.circle.com/openapi/gateway.yaml`). The monitor therefore
   needs no API key and no database.

## 6. The tools

| Tool | Price | Answers | Sources |
|---|---|---|---|
| `arc_chain_status` | **free** | Chain ID, latest/safe/finalized block, block time, cost of a transfer in dollars, canonical Circle addresses, per-provider RPC health | RPC + registry |
| `arc_gas_quote` | $0.001 | What a transaction costs **in USDC dollars**, optionally `eth_estimateGas` for a supplied tx | RPC |
| `arc_tx_finality` | $0.001 | For a tx hash: `pending` / `included` / `safe` / `finalized`, with confirmations and timestamps | RPC |
| `arc_asset_verify` | $0.002 | Is this address canonical Circle infrastructure, an impersonator of it, or unrelated? With reasons | Registry + RPC + DexScreener |
| `arc_token_liquidity` | $0.005 | Pool liquidity vs. claimed market cap, per pool, with a thin-liquidity verdict | DexScreener + RPC |

`arc_chain_status` is free deliberately: it is the discovery surface, it costs one RPC batch, and
a free tool that works is the cheapest possible proof the server is real.

Prices are defaults; the inherited `PRICE_<TOOL_NAME>` environment override is retained.

### `arc_asset_verify` scope

Three verdicts: `canonical` (address is in the registry), `impersonator` (symbol or name collides
with a canonical Circle asset but the address does not match), `unrelated` (no collision). Every
verdict carries machine-readable `reasons`.

Intentionally narrow. No honeypot detection, contract-risk scoring, or rug prediction. That is
GoPlus's category, not ours.

## 7. The registry contract

`contracts/src/ArcAssetRegistry.sol` — roughly 60 lines, Solidity, Foundry, **no upgradeability,
no proxy**. An owner-set mapping of canonical Circle infrastructure on Arc, seeded at deployment
from `docs.arc.io/arc/references/contract-addresses`: USDC, EURC, USYC, USYC Entitlements, USYC
Teller, GatewayWallet, GatewayMinter, TokenMessengerV2, MessageTransmitterV2, TokenMinterV2,
MessageV2, FxEscrow, Permit2, Multicall3, CREATE2 Factory.

Views: `isCanonical(address)`, `canonicalOf(string symbol)`, `symbolOf(address)`. Events on every
mutation. Ownership transferable and renounceable.

**Why it earns its place.** Two real reasons:

1. `arc_asset_verify` reads it on-chain, so a third party can verify our answer without trusting
   our API. The service's core claim becomes independently checkable.
2. It makes "deployed and working on Arc mainnet" unambiguous to a reviewer. A pure API could be
   argued either way; a verified contract cannot.

Cost is cents of USDC gas.

**Known risk:** `explorer.arc.io` is Cloudflare-walled against non-browser clients (verified:
`curl` to its API returns a challenge page, HTTP 403), so `forge verify-contract` may fail.
Fallback is standard-JSON verification through the explorer UI, driven in a browser.

## 8. Data flow

```
agent → POST /mcp or /x402/<tool>
      → classifyRequest
      → free tool?  → run, return
      → paid tool?  → 402 + Gateway-enhanced requirements
                        (GatewayEvmScheme injects extra.verifyingContract so the buyer
                         signs the correct EIP-712 domain — base ExactEvmScheme drops it)
      → buyer retries with `payment-signature` (EIP-3009, signed off-chain, zero gas)
      → BatchFacilitatorClient.verify
      → run tool
      → success only → settle → Gateway credits seller Gateway balance in a later batch
      → response carries settlement header
```

Buyers must be **EOAs**: Gateway's batch settlement requires EIP-3009 signatures and does not
support ERC-1271 smart-contract wallets. Acceptable for agents, and stated in `SKILL.md`.

## 9. The monitor

Same page, same `MonitorSnapshot` model, same honesty rule carried over verbatim: unreadable
history renders as `null`, never `0`, because "we could not read it" and "nobody has ever paid"
are different facts, and rendering the first as the second is a lie about the product.

Sources swap:

| | Source repo | This repo |
|---|---|---|
| Settlement history | Blockscout Base ERC-20 transfers | `GET /v1/x402/transfers` filtered to the seller |
| Balance | `balanceOf` on Base USDC | `POST /v1/balances` |
| Links | basescan.org | explorer.arc.io |

Gateway settlements carry a Gateway **transfer ID**, not a transaction hash, because settlement
is batched. The page says so rather than rendering a broken explorer link.

## 10. Error handling

The inherited money-safety contract, applied to Arc:

- Any `UpstreamError` propagates; the gate does not settle; the caller is not charged.
- RPC calls rotate across the four public Arc providers and throw only when all fail.
- `arc_asset_verify`'s verdict comes from registry + RPC. DexScreener is **enrichment**: its
  failure yields a `warnings` entry and `null` liquidity, not a failed call.
- `arc_token_liquidity`'s core source **is** DexScreener, so its failure throws.
- No tool depends on wide `eth_getLogs` ranges (see §5.4).

## 11. Testing

- Vitest per tool against fixture RPC and DexScreener responses, including:
  - the 18-decimal-gas vs 6-decimal-ERC-20 case,
  - a confusable-symbol impersonation case built from a real observed example
    (`USDCARC` at `0xaaC788737179Cd696d19b1A09c5392033C9127A6`, ~$2.5k liquidity).
- Paywall tests reusing the inherited fake resource server against the Gateway scheme.
- Monitor tests against fixture Gateway responses, including the unreadable-history case.
- Docs-drift test (`gen:docs` output must match the Markdown).
- Foundry tests for the registry.

## 12. Out of scope for v1

The **live conformance harness** (it needs paid calls accumulated over time; roadmap). The FX
tool (blocked on StableFX mainnet, §5.6). Any LLM. Accounts or API keys. An indexer or database.
Other chains. A withdrawal UI — withdrawal from the Gateway balance is an operator action. x402
Bazaar listing, which is Coinbase's catalog and does not apply to a Circle-facilitated service;
discovery is `/.well-known/x402` plus `/openapi.json`.

## 13. Operator-gated steps

The build agent does none of these. They need accounts, money, or keys.

1. **USDC on Arc mainnet.** Gates everything below. Acquire via a listed Arc exchange partner or
   CCTP from another chain.
2. A **public** payout address for `PAYOUT_WALLET_ADDRESS`.
3. A deployer EOA holding a few cents of USDC on Arc, to deploy the registry.
4. A buyer EOA with a small Gateway deposit on Arc, to generate a real mainnet settlement.
5. `wrangler login`, secrets, deploy.
6. The `arc.agentfund.net` DNS record.
7. The DoraHacks submission itself.

Runbook: `OPERATOR_CHECKLIST.md`.

## 14. Same-day plan (2026-09-18)

Submission is today, so the order is driven by what unblocks the operator earliest.

| Phase | Owner | Work |
|---|---|---|
| 1 | agent | Config + payment swap, Arc RPC layer, five tools, tests |
| 2 | **operator, in parallel** | Acquire USDC on Arc; `wrangler login` |
| 3 | agent | Registry contract + Foundry tests; monitor; docs; public repo pushed |
| 4 | operator | Deploy registry; deploy Worker; fund Gateway; one real paid call |
| 5 | agent | Record the live results in `VERIFICATION.md`; final push |
| 6 | operator | Submit on DoraHacks |

The deadline is 2026-10-14, so a same-day submission spends none of the available slack. If
phase 4 slips past today, the submission simply happens tomorrow with no penalty beyond losing a
day of rolling-review priority.
