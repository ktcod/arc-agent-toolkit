import { describe, it, expect } from "vitest";
import { decide } from "../src/tools/arcAssetVerify.js";
import {
  collidesWithCanonical,
  normalizeSymbol,
  canonicalByAddress,
} from "../src/upstream/arcRegistry.js";

const REAL_USDC = "0x3600000000000000000000000000000000000000";
/** Observed on Arc 2026-09-18 via DexScreener: a real USDC-alike with ~$2.5k liquidity. */
const USDCARC = "0xaac788737179cd696d19b1a09c5392033c9127a6";

describe("symbol collision", () => {
  it("catches the impersonator actually trading on Arc", () => {
    expect(collidesWithCanonical("USDCARC")).toBe("USDC");
  });

  it("catches common squat shapes", () => {
    for (const s of ["USDC", "usdc", "1USDC", "USDC.e", "USDC_v2", "xUSDCx"]) {
      expect(collidesWithCanonical(s)).toBe("USDC");
    }
    expect(collidesWithCanonical("EURC2")).toBe("EURC");
  });

  it("does not flag ordinary tokens", () => {
    for (const s of ["DUKE", "ARCANIUM", "WETH", "PEG", null]) {
      expect(collidesWithCanonical(s as string | null)).toBeNull();
    }
  });

  it("normalizes punctuation away", () => {
    expect(normalizeSymbol("USDC.e")).toBe("usdce");
    expect(normalizeSymbol("  us-dc ")).toBe("usdc");
  });
});

describe("verdict", () => {
  const canonical = { isCanonical: true, symbol: "USDC", source: "onchain" as const };
  const notCanonical = { isCanonical: false, symbol: null, source: "onchain" as const };

  it("calls the real USDC canonical", () => {
    const d = decide(REAL_USDC, "USDC", canonical);
    expect(d.verdict).toBe("canonical");
    expect(d.impersonates).toBeNull();
  });

  it("calls a colliding non-registered address an impersonator", () => {
    const d = decide(USDCARC, "USDCARC", notCanonical);
    expect(d.verdict).toBe("impersonator");
    expect(d.impersonates).toBe("USDC");
    expect(d.reasons.join(" ")).toContain("gas asset");
  });

  it("calls a non-colliding token unrelated", () => {
    expect(decide("0x1234567890123456789012345678901234567890", "DUKE", notCanonical).verdict).toBe(
      "unrelated",
    );
  });

  it("prefers the registry over the symbol, so a canonical address is never an impersonator", () => {
    // Registry wins: an address that IS canonical cannot be flagged for its own symbol.
    expect(decide(REAL_USDC, "USDC", canonical).verdict).toBe("canonical");
  });
});

describe("built-in canonical table", () => {
  it("resolves real USDC case-insensitively", () => {
    expect(canonicalByAddress(REAL_USDC.toUpperCase())?.symbol).toBe("USDC");
  });
  it("does not contain the impersonator", () => {
    expect(canonicalByAddress(USDCARC)).toBeUndefined();
  });
});
