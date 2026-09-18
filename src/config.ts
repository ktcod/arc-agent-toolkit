import type { Network } from "@x402/core/types";

export type X402Mode = "sandbox" | "production";

export type Env = Record<string, string | undefined>;

export interface ToolPriceSpec {
  name: string;
  defaultPrice: string;
}

export interface AppConfig {
  /** Public payout address. Never a private key. */
  payTo: `0x${string}`;
  network: Network;
  mode: X402Mode;
  /** Circle Gateway facilitator base URL (batched x402 / Nanopayments). */
  facilitatorUrl: string;
  /** Deployed ArcAssetRegistry, or undefined to fall back to the built-in table. */
  registryAddress?: `0x${string}`;
  /** toolName -> normalized USD price (e.g. "$0.01"). */
  prices: Record<string, string>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Arc mainnet. Gas is USDC; settlement runs through Circle Gateway. */
export const ARC_MAINNET = "eip155:5042" as Network;
/** Arc testnet, for the sandbox deployment. */
export const ARC_TESTNET = "eip155:5042002" as Network;

export const GATEWAY_MAINNET = "https://gateway-api.circle.com";
export const GATEWAY_TESTNET = "https://gateway-api-testnet.circle.com";

/** The only two networks this server speaks. It is an Arc product; there is no Base fallback. */
export const SUPPORTED_NETWORKS: Record<string, { facilitator: string; chain: "arc" | "arcTestnet" }> = {
  [ARC_MAINNET]: { facilitator: GATEWAY_MAINNET, chain: "arc" },
  [ARC_TESTNET]: { facilitator: GATEWAY_TESTNET, chain: "arcTestnet" },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export function priceEnvVar(toolName: string): string {
  return "PRICE_" + toolName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function redactAddress(value: string): string {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function normalizePrice(value: string, toolName: string): string {
  const trimmed = value.trim();
  if (!/^\$?\d+(\.\d+)?$/.test(trimmed)) {
    throw new ConfigError(
      `Invalid price "${value}" for tool "${toolName}". Use a USD amount such as "$0.01".`,
    );
  }
  return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
}

/**
 * Resolve and validate the payout address. Hard rule: ADDRESS ONLY — this function actively
 * refuses anything that looks like a private key or seed phrase.
 *
 * This repo is PUBLIC (the microgrant requires it), so this guard is load-bearing rather than
 * merely defensive: it is the last thing standing between a mistyped env var and a published key.
 */
export function resolvePayoutAddress(raw: string | undefined): `0x${string}` {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new ConfigError(
      "PAYOUT_WALLET_ADDRESS is required. Set it to your PUBLIC USDC payout address " +
        "(0x followed by 40 hex characters). Never set a private key.",
    );
  }
  if (/\s/.test(value)) {
    throw new ConfigError(
      "PAYOUT_WALLET_ADDRESS must be a single 0x address, not a phrase. Never use a seed phrase.",
    );
  }
  if (!ADDRESS_RE.test(value) && PRIVATE_KEY_RE.test(value)) {
    throw new ConfigError(
      "PAYOUT_WALLET_ADDRESS looks like a private key (64 hex chars). Refusing to start. " +
        "Provide the PUBLIC wallet address only — this server never needs a private key.",
    );
  }
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(
      `PAYOUT_WALLET_ADDRESS is not a valid EVM address: "${redactAddress(value)}". ` +
        "Expected 0x followed by 40 hex characters.",
    );
  }
  return value as `0x${string}`;
}

/** Optional address-typed env var (currently the registry). Same private-key refusal applies. */
export function resolveOptionalAddress(
  raw: string | undefined,
  varName: string,
): `0x${string}` | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  if (!ADDRESS_RE.test(value) && PRIVATE_KEY_RE.test(value)) {
    throw new ConfigError(
      `${varName} looks like a private key. Refusing to start. Provide a contract address only.`,
    );
  }
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(`${varName} is not a valid EVM address: "${redactAddress(value)}".`);
  }
  return value as `0x${string}`;
}

export function loadConfig(env: Env, paidTools: ToolPriceSpec[]): AppConfig {
  const payTo = resolvePayoutAddress(env.PAYOUT_WALLET_ADDRESS);

  const mode: X402Mode =
    (env.X402_MODE ?? "sandbox").trim().toLowerCase() === "production" ? "production" : "sandbox";

  const network = (env.X402_NETWORK?.trim() ||
    (mode === "production" ? ARC_MAINNET : ARC_TESTNET)) as Network;

  const supported = SUPPORTED_NETWORKS[network];
  if (!supported) {
    throw new ConfigError(
      `X402_NETWORK must be "${ARC_MAINNET}" (Arc mainnet) or "${ARC_TESTNET}" (Arc testnet). ` +
        `Got "${network}". This server settles on Arc only.`,
    );
  }

  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() || supported.facilitator;
  const registryAddress = resolveOptionalAddress(env.ARC_REGISTRY_ADDRESS, "ARC_REGISTRY_ADDRESS");

  const prices: Record<string, string> = {};
  for (const tool of paidTools) {
    prices[tool.name] = normalizePrice(env[priceEnvVar(tool.name)] ?? tool.defaultPrice, tool.name);
  }

  return { payTo, network, mode, facilitatorUrl, registryAddress, prices };
}

/** Which Arc chain a configured network maps to, for RPC reads. */
export function chainForNetwork(network: Network): "arc" | "arcTestnet" {
  return SUPPORTED_NETWORKS[network]?.chain ?? "arc";
}
