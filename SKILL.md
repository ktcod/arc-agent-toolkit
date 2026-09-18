# Arc Agent Toolkit — agent guide

Pay-per-call data tools for **Arc**, Circle's stablecoin-native L1. Settled in USDC **on Arc
mainnet** via Circle Nanopayments (Gateway's batched x402). No account, no API key, no
subscription.

- MCP endpoint: `POST /mcp` (streamable HTTP, stateless)
- Per-tool HTTP: `POST /x402/<tool>` with arguments as a plain JSON body
- Discovery: `GET /.well-known/x402`, `GET /openapi.json`
- Live settlements: `GET /monitor`

## Paying

1. Call a paid tool. You get **HTTP 402** with payment requirements.
2. Sign an **EIP-3009** authorization off-chain (zero gas) and retry with the
   `payment-signature` header.
3. Circle Gateway verifies, the tool runs, and settlement happens only **after** the tool
   succeeds.

Two things to know:

- **You must be an EOA.** Gateway's batch settlement requires EIP-3009 signatures and does not
  support ERC-1271 smart-contract wallets.
- **You need a Gateway balance**, funded by a one-time on-chain deposit into the GatewayWallet
  at `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`. After that, individual payments cost no gas.

`@circle-fin/x402-batching`'s `GatewayClient` handles both sides of this for you.

**A failed call is never billed.** If a tool's upstream fails, the error propagates and
settlement is skipped. You are never charged for a result you did not receive.

## The tools

| Tool | Price | Use it for |
|---|---|---|
| `arc_chain_status` | **free** | Orienting on Arc: heads, gas, canonical Circle addresses |
| `arc_gas_quote` | $0.001 | What will this transaction cost me, in dollars |
| `arc_tx_finality` | $0.001 | Is my transaction irreversible yet |
| `arc_asset_verify` | $0.002 | Is this really USDC, or an impersonator |
| `arc_token_liquidity` | $0.005 | Can I actually get out of this position |

### `arc_chain_status` (free)

No arguments. Returns chain id, `latest` / `safe` / `finalized` block heights, gas price, the
cost of a plain transfer in USDC dollars, and the full canonical Circle address table.

Start here. It is free, so it is also the cheapest way to confirm the service is live.

### `arc_gas_quote`

`preset` (transfer | erc20Transfer | swap | deploy), or `gasUnits`, or `to` (+ optional `from`,
`data`) to run a live `eth_estimateGas`.

Arc pays gas in USDC, so a quote is directly a dollar figure with no token-price lookup. If you
supply `to` and the estimate fails (for example the transaction would revert), the call
**errors** rather than quietly falling back to a preset — and is therefore not billed.

### `arc_tx_finality`

`txHash` (required). Returns one of `unknown`, `pending`, `included`, `safe`, `finalized`, with
confirmations and the three chain heads.

Arc exposes real `safe` and `finalized` tags, so this is a deterministic answer rather than a
confirmation-count heuristic. Use `finalized` as your settlement trigger.

### `arc_asset_verify`

`address` (required). Returns `canonical`, `impersonator` or `unrelated`, with reasons.

On Arc, USDC is the gas asset, which makes its ticker the highest-value squat on the chain.
Impersonators already trade there. The canonical list is read from an **on-chain registry**, so
you can check the answer yourself rather than trusting this API; `registrySource` tells you
whether the contract or the built-in fallback table answered.

Scope is narrow on purpose: this answers "is this the real Circle asset it appears to be?" It
does **not** do honeypot detection, contract-risk scoring or rug prediction, and will not
pretend to.

### `arc_token_liquidity`

`address` (required). Returns pooled liquidity across every indexed Arc pool, the claimed market
cap, their ratio, and a depth band (`none` / `thin` / `moderate` / `deep`).

Market cap on a young chain is notional: it is price times supply, where the price comes from a
pool that may hold a few thousand dollars. This tells you what is actually there.

## Limits, stated plainly

- **Arc only.** No other chain is supported, by design.
- **Liquidity data comes from DexScreener** and inherits its indexing coverage. A token with no
  indexed pool returns `poolCount: 0`, which is a finding, not an error.
- **`arc_asset_verify` is about canonical Circle assets**, not general token safety.
- **No FX tool yet.** StableFX's mainnet escrow is still a stub (see VERIFICATION.md §8), so
  shipping one would mean reporting confident results read from a placeholder.
- **No live conformance results yet.** See the end of VERIFICATION.md.
