import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";
import { tools, paidToolSpecs } from "../src/tools/index.js";

const ENV = {
  PAYOUT_WALLET_ADDRESS: "0x9C1D17a47DB9F3eF9Eeaf747023E2a7CC29c9b66",
  X402_MODE: "production",
  X402_NETWORK: "eip155:5042",
  X402_FACILITATOR_URL: "https://gateway-api.circle.com",
};

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://svc.example${path}`, init), ENV);

describe("service surface", () => {
  it("reports healthy on Arc mainnet", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.network).toBe("eip155:5042");
  });

  it("refuses to start against a non-Arc network", async () => {
    const res = await app.fetch(new Request("https://svc.example/health"), {
      ...ENV,
      X402_NETWORK: "eip155:8453",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(body.status).toBe("misconfigured");
    expect(String(body.error)).toContain("Arc");
  });

  it("refuses a private key in the payout address", async () => {
    const res = await app.fetch(new Request("https://svc.example/health"), {
      ...ENV,
      PAYOUT_WALLET_ADDRESS: "0x" + "a".repeat(64),
    });
    expect(res.status).toBe(500);
    expect(String(((await res.json()) as Record<string, unknown>).error)).toContain("private key");
  });

  it("serves discovery and the agent guide", async () => {
    expect((await call("/.well-known/x402")).status).toBe(200);
    expect((await call("/openapi.json")).status).toBe(200);
    const skill = await call("/SKILL.md");
    expect(skill.status).toBe(200);
    expect(await skill.text()).toContain("Arc Agent Toolkit");
  });

  it("lists every tool in the manifest", async () => {
    const body = (await (await call("/")).json()) as { tools?: Array<{ name: string }> };
    expect(body.tools?.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
  });
});

describe("payment gating", () => {
  it("answers tools/list without payment", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

  it("charges for exactly the tools that declare a price", () => {
    const paid = paidToolSpecs().map((s) => s.name);
    expect(paid).not.toContain("arc_chain_status"); // free: the discovery surface
    expect(paid.sort()).toEqual(
      ["arc_asset_verify", "arc_gas_quote", "arc_token_liquidity", "arc_tx_finality"].sort(),
    );
  });
});
