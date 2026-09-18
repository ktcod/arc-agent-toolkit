# Operator Checklist

Steps that need accounts, money, or keys. The build agent does **not** perform these. Order
matters top to bottom.

> **Golden rule:** this server only ever needs your **public** wallet address. Never put a
> private key, seed phrase, or mnemonic in this repo, in `.dev.vars`, in `wrangler secret`, in
> an env var, or in any prompt. If a 64-hex string is ever set as `PAYOUT_WALLET_ADDRESS`, the
> server refuses to start by design. **This repo is public** — that guard is load-bearing.
>
> The one place a private key is used is `forge script` in step 2, which reads it from your
> shell and never writes it to disk. Prefer `--interactive` or a hardware wallet.

---

## 0. Prerequisites

- [ ] A funded EOA on Arc mainnet. Deployment costs cents; ~$1 of USDC is ample.
      Check: `cast balance <addr> --rpc-url https://rpc.mainnet.arc.io`
- [ ] Foundry (`forge`), Node 22+, a Cloudflare account.

## 1. Confirm your payout address

The default in `wrangler.toml` is `0x9C1D17a47DB9F3eF9Eeaf747023E2a7CC29c9b66`. Change it in
both `[vars]` and `[env.production.vars]` if you are not that person.

This address is **public by design**: the monitor publishes it so anyone can audit settlements.

## 2. Deploy the registry to Arc mainnet

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.mainnet.arc.io \
  --broadcast \
  --interactive
```

`--interactive` prompts for the key rather than taking it from the environment. The script
deploys `ArcAssetRegistry` and seeds all 15 canonical entries **in the same broadcast**, so the
registry is never briefly live-and-empty (which would make `isCanonical` answer "false" for real
USDC).

- [ ] Record the printed address.
- [ ] Sanity check it:

```bash
cast call <REGISTRY> "isCanonical(address)(bool)" \
  0x3600000000000000000000000000000000000000 --rpc-url https://rpc.mainnet.arc.io   # true
cast call <REGISTRY> "isCanonical(address)(bool)" \
  0xaaC788737179Cd696d19b1A09c5392033C9127A6 --rpc-url https://rpc.mainnet.arc.io   # false
```

- [ ] Set `ARC_REGISTRY_ADDRESS` in `wrangler.toml` under `[env.production.vars]`. Without it
      the service still answers correctly from the built-in table, but `registrySource` reports
      `builtin` rather than `onchain`.

### Verifying the source

```bash
forge verify-contract <REGISTRY> src/ArcAssetRegistry.sol:ArcAssetRegistry \
  --chain-id 5042 --verifier blockscout \
  --verifier-url https://explorer.arc.io/api
```

Expect this to **fail**: `explorer.arc.io` sits behind Cloudflare and rejects non-browser
clients (VERIFICATION.md §10). Fall back to the explorer UI: open the contract address, choose
*Verify & Publish*, select *Solidity (Standard JSON Input)*, and upload
`contracts/out/ArcAssetRegistry.sol/ArcAssetRegistry.json`.

## 3. Deploy the Worker

```bash
npx wrangler login
npm run build
npx wrangler deploy --env production
```

- [ ] `curl https://<worker-url>/health` reports `"status":"ok"` and `"network":"eip155:5042"`.
- [ ] `curl https://<worker-url>/x402/arc_gas_quote -X POST -d '{}'` returns **HTTP 402** with a
      `payment-required` header.
- [ ] `/monitor` renders.

## 4. Prove a real mainnet payment

The submission is much stronger with at least one settled payment, and it is what makes the
monitor show something.

- [ ] Deposit a small amount of USDC into the Gateway wallet
      (`0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`) from a **buyer** EOA. Use
      `GatewayClient.deposit()` from `@circle-fin/x402-batching/client`, or Circle's own
      Nanopayments sample app.
- [ ] Pay for one call:

```bash
node scripts/pay-http.mjs https://<worker-url>/x402/arc_gas_quote '{"preset":"swap"}'
```

- [ ] Confirm the payment appears at `/monitor`.

Remember: the buyer must be an **EOA**. Gateway's batch settlement does not support ERC-1271
smart-contract wallets.

## 5. Custom domain (optional)

Point `arc.agentfund.net` at the Worker via a Cloudflare Workers custom domain.

## 6. Submit

[dorahacks.io/hackathon/arc-microgrants](https://dorahacks.io/hackathon/arc-microgrants/detail)

Needs: the live deployment URL, the public repo, a short description, and a public builder
profile (GitHub, X, or Farcaster). Submissions close **2026-10-14 23:59 ET**, reviewed on a
rolling basis with all decisions by **2026-10-21**.

## 7. Withdraw earnings

Seller revenue accumulates in your **Gateway balance**, not directly in your wallet. Withdraw to
any Gateway-supported chain with a single cross-chain call. There is no withdrawal UI in this
project by design.
