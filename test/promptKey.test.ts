import { describe, it, expect, afterEach } from "vitest";
import { resolvePrivateKey } from "../scripts/lib/prompt-key.mjs";

// A well-known Anvil/Hardhat test key. Public, worthless, and safe to hard-code.
const ANVIL = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

afterEach(() => {
  delete process.env.TEST_KEY;
});

describe("private key input", () => {
  it("accepts a bare 64-hex key, which is what MetaMask exports", async () => {
    process.env.TEST_KEY = ANVIL;
    expect(await resolvePrivateKey("TEST_KEY")).toBe(`0x${ANVIL}`);
  });

  it("accepts a key that already carries the 0x prefix", async () => {
    process.env.TEST_KEY = `0x${ANVIL}`;
    expect(await resolvePrivateKey("TEST_KEY")).toBe(`0x${ANVIL}`);
  });

  it("tolerates surrounding whitespace from a clipboard paste", async () => {
    process.env.TEST_KEY = `  ${ANVIL}\n`;
    expect(await resolvePrivateKey("TEST_KEY")).toBe(`0x${ANVIL}`);
  });

  it("rejects a placeholder rather than passing it to the signer", async () => {
    process.env.TEST_KEY = "0xYOURKEY";
    await expect(resolvePrivateKey("TEST_KEY")).rejects.toThrow(/64 hex characters/);
  });

  it("rejects a seed phrase, which is a far worse thing to leak than one key", async () => {
    process.env.TEST_KEY = "test test test test test test test test test test test junk";
    await expect(resolvePrivateKey("TEST_KEY")).rejects.toThrow();
  });

  it("rejects a truncated key instead of silently padding it", async () => {
    process.env.TEST_KEY = ANVIL.slice(0, 60);
    await expect(resolvePrivateKey("TEST_KEY")).rejects.toThrow();
  });
});
