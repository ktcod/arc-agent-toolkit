import { describe, it, expect } from "vitest";
import { weiToUsdc, round9, GAS_PRESETS } from "../src/tools/arcGasQuote.js";
import { costInUsdc, TRANSFER_GAS, readBlock } from "../src/tools/arcChainStatus.js";
import { NATIVE_DECIMALS } from "../src/upstream/evm.js";

/**
 * The decimal trap is the single most likely bug in any Arc integration: gas is USDC, but the
 * native unit is 18 decimals while the USDC ERC-20 reports 6. These tests pin the conversion.
 */
describe("Arc gas is USDC at 18 decimals, not 6", () => {
  it("prices a plain transfer at the observed mainnet rate", () => {
    // Observed 2026-09-18 on Arc mainnet: eth_gasPrice == 0x4a817d33c == 20000002876 wei,
    // i.e. 20.000002876 gwei (not a round 20). A transfer is 21,000 gas.
    const gasPrice = BigInt("0x4a817d33c");
    expect(Number(gasPrice)).toBe(20_000_002_876);
    expect(Number(gasPrice) / 1e9).toBeCloseTo(20.000002876, 9);
    expect(costInUsdc(gasPrice, TRANSFER_GAS)).toBeCloseTo(0.000420000060396, 15);
    expect(round9(costInUsdc(gasPrice, TRANSFER_GAS))).toBe(0.00042);
  });

  it("would be off by a trillion if the ERC-20's 6 decimals were used", () => {
    const gasPrice = BigInt("0x4a817d33c");
    const correct = weiToUsdc(gasPrice * TRANSFER_GAS);
    const wrong = Number(gasPrice * TRANSFER_GAS) / 10 ** 6;
    expect(wrong / correct).toBeCloseTo(10 ** (NATIVE_DECIMALS - 6), 0);
  });

  it("scales every preset off the same conversion", () => {
    const gasPrice = 20_000_000_000n;
    expect(round9(weiToUsdc(gasPrice * GAS_PRESETS.transfer))).toBeCloseTo(0.00042, 9);
    expect(round9(weiToUsdc(gasPrice * GAS_PRESETS.swap))).toBeCloseTo(0.003, 9);
  });

  it("treats zero gas price as free rather than NaN", () => {
    expect(weiToUsdc(0n)).toBe(0);
  });
});

describe("readBlock", () => {
  it("parses a header", () => {
    expect(readBlock({ number: "0x148fc0a", timestamp: "0x6aa8f00b" }).number).toBe(21_560_330);
  });
  it("survives a missing or malformed header", () => {
    expect(readBlock(null)).toEqual({ number: null, timestamp: null });
    expect(readBlock("not an object")).toEqual({ number: null, timestamp: null });
    expect(readBlock({})).toEqual({ number: null, timestamp: null });
  });
});
