/**
 * Canonical Circle infrastructure on Arc.
 *
 * Two sources, in priority order:
 *   1. The deployed ArcAssetRegistry contract (when ARC_REGISTRY_ADDRESS is set). Reading it
 *      on-chain means a third party can check our answer without trusting this API.
 *   2. This built-in table, transcribed from docs.arc.io/arc/references/contract-addresses.
 *
 * The built-in table is the fallback rather than the primary so that the on-chain record is
 * authoritative, but the service still answers correctly before the contract is deployed.
 */
import { assertAddress, ethCall, decodeAbiString, hexToBigInt, type ChainKey } from "./evm.js";

export interface CanonicalAsset {
  symbol: string;
  address: string;
  /** What this contract is, in one phrase. */
  role: string;
  /** True for assets a scam token would plausibly impersonate by symbol. */
  impersonable: boolean;
}

/**
 * Canonical contracts on Arc mainnet, from the Arc docs.
 *
 * `impersonable` marks the ones whose SYMBOL is worth squatting. A fake "USDC" is the whole
 * attack surface on a chain where USDC is the gas asset; nobody launches a fake Multicall3.
 */
export const CANONICAL: CanonicalAsset[] = [
  { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", role: "Circle USDC (also the native gas asset)", impersonable: true },
  { symbol: "EURC", address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", role: "Circle EURC", impersonable: true },
  { symbol: "USYC", address: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490", role: "Hashnote USYC", impersonable: true },
  { symbol: "USYC_ENTITLEMENTS", address: "0xb69ecb156Dc0028198028c501340d5367845ca72", role: "USYC entitlements", impersonable: false },
  { symbol: "USYC_TELLER", address: "0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b", role: "USYC teller", impersonable: false },
  { symbol: "GATEWAY_WALLET", address: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE", role: "Circle Gateway wallet (Nanopayments settlement)", impersonable: false },
  { symbol: "GATEWAY_MINTER", address: "0x2222222d7164433c4C09B0b0D809a9b52C04C205", role: "Circle Gateway minter", impersonable: false },
  { symbol: "TOKEN_MESSENGER_V2", address: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", role: "CCTP v2 TokenMessenger", impersonable: false },
  { symbol: "MESSAGE_TRANSMITTER_V2", address: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", role: "CCTP v2 MessageTransmitter", impersonable: false },
  { symbol: "TOKEN_MINTER_V2", address: "0xfd78EE919681417d192449715b2594ab58f5D002", role: "CCTP v2 TokenMinter", impersonable: false },
  { symbol: "MESSAGE_V2", address: "0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78", role: "CCTP v2 Message", impersonable: false },
  { symbol: "FX_ESCROW", address: "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6", role: "StableFX escrow (a stub on mainnet as of 2026-09-18)", impersonable: false },
  { symbol: "PERMIT2", address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", role: "Uniswap Permit2", impersonable: false },
  { symbol: "MULTICALL3", address: "0xcA11bde05977b3631167028862bE2a173976CA11", role: "Multicall3", impersonable: false },
  { symbol: "CREATE2_FACTORY", address: "0x4e59b44847b379578588920cA78FbF26c0B4956C", role: "Deterministic CREATE2 factory", impersonable: false },
];

const BY_ADDRESS = new Map(CANONICAL.map((a) => [a.address.toLowerCase(), a]));

/** Symbols worth impersonating, lowercased, for confusable matching. */
export const IMPERSONABLE_SYMBOLS = CANONICAL.filter((a) => a.impersonable).map((a) =>
  a.symbol.toLowerCase(),
);

export function canonicalByAddress(address: string): CanonicalAsset | undefined {
  return BY_ADDRESS.get(address.trim().toLowerCase());
}

/** Selector for `isCanonical(address)` on ArcAssetRegistry. */
const SEL_IS_CANONICAL = "0xb754bdfa";
/** Selector for `symbolOf(address)` on ArcAssetRegistry. */
const SEL_SYMBOL_OF = "0xec7cf0ea";

export interface RegistryAnswer {
  isCanonical: boolean;
  symbol: string | null;
  /** "onchain" when the deployed registry answered, "builtin" when the fallback table did. */
  source: "onchain" | "builtin";
}

/**
 * Ask the registry whether an address is canonical.
 *
 * Falls back to the built-in table when no registry is configured OR when the on-chain read
 * fails. A registry outage must not turn a correct answer into an error: the built-in table is
 * the same data, just not independently checkable.
 */
export async function lookupCanonical(
  chain: ChainKey,
  address: string,
  registryAddress: string | undefined,
  env?: Record<string, string | undefined>,
): Promise<RegistryAnswer> {
  const addr = assertAddress(address, "address");

  if (registryAddress) {
    try {
      const padded = "0".repeat(24) + addr.slice(2);
      const raw = await ethCall(chain, registryAddress, SEL_IS_CANONICAL + padded, env);
      const flag = hexToBigInt(raw);
      if (flag !== null) {
        let symbol: string | null = null;
        if (flag === 1n) {
          symbol = decodeAbiString(
            await ethCall(chain, registryAddress, SEL_SYMBOL_OF + padded, env),
          );
        }
        return { isCanonical: flag === 1n, symbol, source: "onchain" };
      }
    } catch {
      // fall through to the built-in table
    }
  }

  const hit = canonicalByAddress(addr);
  return { isCanonical: Boolean(hit), symbol: hit?.symbol ?? null, source: "builtin" };
}

/**
 * Normalize a symbol for confusable comparison: lowercase, and strip characters commonly used
 * to pad a squatted ticker (USDC -> "usdc", "USDC.e" -> "usdce", "1USDC" -> "1usdc").
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does `symbol` collide with a canonical impersonable symbol?
 *
 * Matches exact equality after normalization, and containment (so "USDCARC", "1USDC" and
 * "USDC_v2" all collide with USDC). Deliberately conservative about short symbols: a two-letter
 * canonical symbol would match far too much, so containment only applies at length >= 4.
 */
export function collidesWithCanonical(symbol: string | null): string | null {
  if (!symbol) return null;
  const s = normalizeSymbol(symbol);
  if (!s) return null;
  for (const canon of IMPERSONABLE_SYMBOLS) {
    if (s === canon) return canon.toUpperCase();
    if (canon.length >= 4 && s.includes(canon)) return canon.toUpperCase();
  }
  return null;
}
