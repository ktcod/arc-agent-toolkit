/**
 * DexScreener access, scoped to Arc.
 *
 * Verified 2026-09-18: DexScreener indexes Arc under chainId "arc", so this is the one keyless
 * source for pool liquidity and market cap. There is no API key and no documented rate limit
 * beyond ordinary fair use.
 */
import { fetchJson, UpstreamError } from "./http.js";

const BASE = "https://api.dexscreener.com/latest/dex";
/** DexScreener's own identifier for Arc. Not the CAIP-2 id. */
export const DEX_CHAIN_ID = "arc";

interface RawPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
}

export interface Pool {
  dex: string | null;
  pairAddress: string | null;
  url: string | null;
  baseSymbol: string | null;
  baseName: string | null;
  baseAddress: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPercent: number | null;
  createdAt: string | null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function toPool(p: RawPair): Pool {
  return {
    dex: p.dexId ?? null,
    pairAddress: p.pairAddress ?? null,
    url: p.url ?? null,
    baseSymbol: p.baseToken?.symbol ?? null,
    baseName: p.baseToken?.name ?? null,
    baseAddress: p.baseToken?.address ?? null,
    quoteSymbol: p.quoteToken?.symbol ?? null,
    priceUsd: num(p.priceUsd),
    liquidityUsd: num(p.liquidity?.usd),
    marketCapUsd: num(p.marketCap) ?? num(p.fdv),
    volume24hUsd: num(p.volume?.h24),
    priceChange24hPercent: num(p.priceChange?.h24),
    createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
  };
}

/** Keep only Arc pools. DexScreener's token endpoint can return pools on other chains. */
export function arcPoolsOnly(pairs: RawPair[] | null | undefined): Pool[] {
  return (pairs ?? []).filter((p) => p.chainId === DEX_CHAIN_ID).map(toPool);
}

/**
 * Every Arc pool for a token address. Returns [] when the token simply has no pools — that is a
 * fact, not a failure. Throws only when DexScreener itself is unreachable.
 */
export async function poolsForToken(address: string): Promise<Pool[]> {
  const data = await fetchJson<{ pairs?: RawPair[] }>(`${BASE}/tokens/${address}`, {
    source: "DexScreener",
  });
  return arcPoolsOnly(data.pairs);
}

/** The deepest pool by USD liquidity, or null when there are none. */
export function deepestPool(pools: Pool[]): Pool | null {
  let best: Pool | null = null;
  for (const p of pools) {
    if (p.liquidityUsd === null) continue;
    if (!best || best.liquidityUsd === null || p.liquidityUsd > best.liquidityUsd) best = p;
  }
  return best ?? (pools[0] ?? null);
}

export { UpstreamError };
