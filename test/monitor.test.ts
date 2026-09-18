import { describe, it, expect } from "vitest";
import {
  buildSnapshot,
  isRetryable,
  toSettlements,
  toolsForAmount,
  fetchTransfers,
  fetchBalance,
  ARC_GATEWAY_DOMAIN,
} from "../src/monitor.js";
import { UpstreamError } from "../src/upstream/http.js";
import type { PaidToolSpec } from "../src/tools/index.js";

const PAY_TO = "0x9C1D17a47DB9F3eF9Eeaf747023E2a7CC29c9b66";
const specs = [
  { name: "arc_gas_quote", defaultPrice: "$0.001", title: "", description: "" },
  { name: "arc_tx_finality", defaultPrice: "$0.001", title: "", description: "" },
  { name: "arc_asset_verify", defaultPrice: "$0.002", title: "", description: "" },
] as PaidToolSpec[];

describe("attributing a settlement to a tool", () => {
  it("names the tool when the price is unique", () => {
    expect(toolsForAmount(0.002, specs)).toEqual(["arc_asset_verify"]);
  });
  it("lists every candidate when two tools share a price", () => {
    expect(toolsForAmount(0.001, specs)).toEqual(["arc_gas_quote", "arc_tx_finality"]);
  });
});

describe("toSettlements", () => {
  // Field names copied from a REAL GET /v1/x402/transfers response (2026-09-18). Gateway uses
  // toAddress/fromAddress/txHash, NOT the x402 protocol's payTo/payer/transactionHash.
  const rows = [
    { id: "t1", status: "received", createdAt: "2026-09-18T10:00:00Z", amount: "2000", fromAddress: "0xA", toAddress: PAY_TO, txHash: null },
    { id: "t2", status: "received", createdAt: "2026-09-18T11:00:00Z", amount: "1000", fromAddress: "0xB", toAddress: PAY_TO, txHash: null },
    // Another seller entirely. Gateway ignores the payTo query filter and returns these, so the
    // client-side filter is the only thing keeping strangers' payments off a public page.
    { id: "t3", status: "received", createdAt: "2026-09-18T12:00:00Z", amount: "50000", fromAddress: "0x718cef2764b833ea0358e51b1171d1b0a55a8587", toAddress: "0x7c9a886c485a33a9636a685c867eafbd15515e86", txHash: null },
  ];

  it("counts only value arriving at the payout address", () => {
    const out = toSettlements(rows, PAY_TO, specs);
    expect(out.map((s) => s.transferId)).toEqual(["t2", "t1"]); // newest first
  });

  it("converts 6-decimal atomic amounts to dollars", () => {
    expect(toSettlements(rows, PAY_TO, specs).find((s) => s.transferId === "t1")?.amountUsdc).toBe(
      0.002,
    );
  });

  it("matches the payout address case-insensitively", () => {
    expect(toSettlements(rows, PAY_TO.toLowerCase(), specs)).toHaveLength(2);
  });

  it("excludes other sellers, because Gateway ignores the payTo query filter", () => {
    // Verified live: a request filtered to one address returned 50 rows, 1 of them ours.
    // Without this filter the public monitor would publish strangers' payment records.
    const out = toSettlements(rows, PAY_TO, specs);
    expect(out.map((s) => s.transferId)).not.toContain("t3");
    expect(out.every((s) => s.payer !== "0x718cef2764b833ea0358e51b1171d1b0a55a8587")).toBe(true);
  });

  it("returns nothing rather than everything when no payout address is configured", () => {
    // An empty target must never degrade into "match all".
    expect(toSettlements(rows, "", specs)).toHaveLength(0);
  });

  it("reads the real Gateway row for the first settled payment on this service", () => {
    const real = [{
      id: "6b757aad-ae4b-4c2b-8e12-ccf83a125be0",
      status: "received",
      createdAt: "2026-09-18T22:43:11.940Z",
      amount: "1000",
      fromAddress: "0x9c1d17a47db9f3ef9eeaf747023e2a7cc29c9b66",
      toAddress: "0x0704d068846ad778b4277c249642e65ae64473b1",
      txHash: null,
    }];
    const [s] = toSettlements(real, "0x0704D068846AD778b4277c249642E65Ae64473b1", specs);
    expect(s.amountUsdc).toBe(0.001);
    expect(s.transferId).toBe("6b757aad-ae4b-4c2b-8e12-ccf83a125be0");
    expect(s.payer).toBe("0x9c1d17a47db9f3ef9eeaf747023e2a7cc29c9b66");
    // Batched settlement: no per-payment tx hash until the batch lands.
    expect(s.txHash).toBeNull();
  });

  it("carries the Gateway transfer id, since batched settlement has no per-payment tx hash", () => {
    const s = toSettlements(rows, PAY_TO, specs)[0];
    expect(s.transferId).toBe("t2");
    expect(s.txHash).toBeNull();
  });
});

describe("retry policy", () => {
  it("retries timeouts and 5xx", () => {
    expect(isRetryable(new UpstreamError("Gateway", "timed out"))).toBe(true);
    expect(isRetryable(new UpstreamError("Gateway", "HTTP 503", 503))).toBe(true);
  });
  it("does not retry a request we got wrong", () => {
    expect(isRetryable(new UpstreamError("Gateway", "HTTP 400", 400))).toBe(false);
    expect(isRetryable(new Error("nope"))).toBe(false);
  });
  it("gives up after three attempts", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new UpstreamError("Gateway", "HTTP 500", 500);
    };
    await expect(
      fetchTransfers("https://g", PAY_TO, "eip155:5042", {
        fetch: failing as never,
        wait: async () => {},
      }),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });
});

describe("an unreadable history is not an empty one", () => {
  it("reports nulls, not zeros, when Gateway cannot be read", async () => {
    const snap = await buildSnapshot(PAY_TO, specs, {
      gatewayUrl: "https://gateway.invalid",
      network: "eip155:5042",
      chain: "arc",
    });
    expect(snap.historyAvailable).toBe(false);
    // The whole point: 0 would read as "nobody has ever paid for this".
    expect(snap.settledCount).toBeNull();
    expect(snap.settledUsdc).toBeNull();
    expect(snap.warnings.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("Gateway balance", () => {
  it("uses Arc's Gateway domain, which is NOT the EVM chain id", async () => {
    // Read from GET /v1/info: Arc reports Gateway domain 26, while its EVM chain id is 5042.
    // Sending the chain id here returns "Invalid gateway domain" and a 400.
    expect(ARC_GATEWAY_DOMAIN).toBe(26);
    let sentBody: unknown;
    await fetchBalance("https://g", PAY_TO, {
      fetch: (async (_url: string, opts: { body?: string }) => {
        sentBody = JSON.parse(opts.body ?? "{}");
        return { balances: [{ domain: 26, balance: "1.5", pendingBatch: "0.5" }] };
      }) as never,
    });
    expect(sentBody).toEqual({
      token: "USDC",
      sources: [{ domain: 26, depositor: PAY_TO }],
    });
  });

  it("counts pending batch value, so fresh revenue does not look lost", async () => {
    // Gateway reports DECIMAL USDC here, not atomic units: the OpenAPI schema types `balance`
    // as ^\d+(\.\d+)?$, which permits a fractional part (atomic values elsewhere in the same
    // spec use the Uint256 type). Dividing by 1e6 would under-report by a million.
    const total = await fetchBalance("https://g", PAY_TO, {
      fetch: (async () => ({
        balances: [{ balance: "1.5", pendingBatch: "0.5" }],
      })) as never,
    });
    expect(total).toBe(2);
  });

  it("does not misread a decimal balance as atomic units", async () => {
    const v = await fetchBalance("https://g", PAY_TO, {
      fetch: (async () => ({ balances: [{ balance: "12.34" }] })) as never,
    });
    expect(v).toBeCloseTo(12.34, 6); // $12.34, not $12,340,000
  });

  it("returns null rather than 0 when the depositor is unknown to Gateway", async () => {
    const v = await fetchBalance("https://g", PAY_TO, {
      fetch: (async () => ({ balances: [] })) as never,
    });
    expect(v).toBeNull();
  });
});
