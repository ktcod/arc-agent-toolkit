# Arc Agent Toolkit

**Pay-per-call MCP tools for [Arc](https://www.arc.io), settled in USDC on Arc mainnet via
[Circle Nanopayments](https://developers.circle.com/gateway/nanopayments).**

Five tools an AI agent needs to operate on Arc, priced in fractions of a cent, with no account,
no API key and no subscription. Plus a small registry contract on Arc mainnet so the canonical
asset answers can be verified on-chain instead of trusted.

| Tool | Price | Answers |
|---|---|---|
| `arc_chain_status` | **free** | Chain heads, gas, canonical Circle addresses |
| `arc_gas_quote` | $0.001 | What a transaction costs, in USDC dollars |
| `arc_tx_finality` | $0.001 | `pending` / `included` / `safe` / `finalized` |
| `arc_asset_verify` | $0.002 | Is this really USDC, or an impersonator? |
| `arc_token_liquidity` | $0.005 | Pooled liquidity vs. claimed market cap |

- **Agent guide:** [SKILL.md](SKILL.md)
- **What was verified against the live chain:** [VERIFICATION.md](VERIFICATION.md)
- **Design:** [docs/superpowers/specs/2026-09-18-arc-agent-toolkit-design.md](docs/superpowers/specs/2026-09-18-arc-agent-toolkit-design.md)
- **Deploying it yourself:** [OPERATOR_CHECKLIST.md](OPERATOR_CHECKLIST.md)

## Why Arc specifically

Arc pays gas in USDC. That one property changes what an agent needs:

- A gas quote is **a dollar figure**, not a token amount to be converted at a volatile price.
- Finality is **deterministic** — Arc exposes real `safe` and `finalized` tags, so an agent can
  know a payment is irreversible instead of counting confirmations.
- And because USDC *is* the gas asset, its ticker is the highest-value thing to squat on the
  chain. Impersonators already trade there: `USDCARC` at `0xaaC7…27A6` holds about $2.5k of
  liquidity against genuine USDC at `0x3600…0000`.

Every tool here exists because of one of those three facts.

## Architecture

- **x402 over Circle Gateway.** `BatchFacilitatorClient` + `GatewayEvmScheme` from
  `@circle-fin/x402-batching`. Gateway aggregates signed EIP-3009 authorizations and settles net
  positions in batches, which is what makes sub-cent payments economic.
- **`GatewayEvmScheme` is not optional.** The base `ExactEvmScheme` drops
  `extra.verifyingContract`, and without it every buyer signs the wrong EIP-712 domain and every
  payment fails. See [VERIFICATION.md §7](VERIFICATION.md).
- **Two entry points, one payment path.** `/mcp` and `/x402/<tool>` both run through
  `PaymentGate`, so money-safety rules cannot drift between them.
- **A failed call is never billed.** The MCP SDK turns a thrown tool error into an HTTP 200
  carrying `isError: true`; the gate inspects the result and returns errors **unsettled**.
- **Stateless.** No database, no indexer, no API keys. Every Circle Gateway endpoint this reads
  is keyless.
- **Adding a tool is a one-file change** plus a line in `src/tools/index.ts`.

## Correctness

Arc-specific behaviour was checked against the live chain before shipping, and the findings are
written down in [VERIFICATION.md](VERIFICATION.md) with the evidence. The one that matters most:

> Arc's native gas unit is **18 decimals** while the USDC ERC-20 at `0x3600…0000` reports **6**.
> A gas quote that divides by `1e6` is wrong by a factor of 10^12 — it would price a $0.00042
> transfer at $420,000,000.

That conversion lives in exactly one function and is pinned by tests against the observed
mainnet gas price.

50 tests: 41 TypeScript (`npm test`) and 9 Solidity (`cd contracts && forge test`).

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run dev       # wrangler dev
```

```bash
cd contracts
forge test
```

## Status

Built for [Arc Microgrants](https://dorahacks.io/hackathon/arc-microgrants/detail).

**Roadmap:** a live conformance harness of real paid calls; `arc_fx_activity` once StableFX is
live on Arc mainnet rather than a stub.

## License

MIT
