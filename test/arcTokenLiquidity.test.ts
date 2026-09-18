import { describe, it, expect } from "vitest";
import { classifyDepth, summarise, verdictFor } from "../src/tools/arcTokenLiquidity.js";
import { arcPoolsOnly, deepestPool, toPool } from "../src/upstream/dexscreener.js";

/** Shape taken from a real DexScreener response for Arc, 2026-09-18. */
const dukePair = {
  chainId: "arc",
  dexId: "uniswap",
  pairAddress: "0xpair",
  baseToken: { address: "0x41358Defd0dedc90528b3F1835715E907B686e6a", symbol: "DUKE", name: "Duke" },
  quoteToken: { address: "0x3600000000000000000000000000000000000000", symbol: "USDC" },
  priceUsd: "0.0011",
  liquidity: { usd: 146135 },
  marketCap: 1144924,
};

describe("depth bands", () => {
  it("classifies the observed Arc tokens", () => {
    expect(classifyDepth(146135)).toBe("moderate"); // DUKE
    expect(classifyDepth(2481)).toBe("thin"); // USDCARC impersonator
    expect(classifyDepth(400_000)).toBe("deep");
  });

  it("treats no pool and zero liquidity as none, not thin", () => {
    expect(classifyDepth(null)).toBe("none");
    expect(classifyDepth(0)).toBe("none");
  });
});

describe("summarise", () => {
  it("sums liquidity and keeps a single token-level market cap", () => {
    const pools = [toPool(dukePair), toPool({ ...dukePair, liquidity: { usd: 1000 } })];
    const { total, mcap, ratio } = summarise(pools);
    expect(total).toBe(147135);
    expect(mcap).toBe(1144924); // not doubled: mcap is a token fact, not a pool fact
    expect(ratio).toBeCloseTo(1144924 / 147135, 6);
  });

  it("returns nulls rather than zeros when there are no pools", () => {
    expect(summarise([])).toEqual({ total: null, mcap: null, ratio: null });
  });

  it("does not divide by zero", () => {
    const { ratio } = summarise([toPool({ ...dukePair, liquidity: { usd: 0 } })]);
    expect(ratio).toBeNull();
  });
});

describe("verdict", () => {
  it("calls out a market cap that is mostly notional", () => {
    expect(verdictFor("thin", 50)).toContain("notional");
  });
  it("says plainly when there is nothing to trade against", () => {
    expect(verdictFor("none", null)).toContain("nothing to trade");
  });
});

describe("chain filtering", () => {
  it("keeps Arc pools and drops everything else", () => {
    const pools = arcPoolsOnly([dukePair, { ...dukePair, chainId: "base" }]);
    expect(pools).toHaveLength(1);
    expect(pools[0].baseSymbol).toBe("DUKE");
  });

  it("picks the deepest pool", () => {
    const pools = arcPoolsOnly([dukePair, { ...dukePair, liquidity: { usd: 999999 } }]);
    expect(deepestPool(pools)?.liquidityUsd).toBe(999999);
  });

  it("returns null for no pools", () => {
    expect(deepestPool([])).toBeNull();
  });
});
