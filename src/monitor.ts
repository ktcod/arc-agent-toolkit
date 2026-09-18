import { CHAINS } from "./upstream/evm.js";
import { fetchJson, UpstreamError } from "./upstream/http.js";
import type { PaidToolSpec } from "./tools/index.js";

/**
 * Live settlement monitor for the payout wallet, on Arc.
 *
 * Both sources are Circle Gateway's own APIs, and both are KEYLESS — verified against
 * developers.circle.com/openapi/gateway.yaml, where the x402 and balances paths carry an empty
 * security array. That is why this service needs no API key and no database.
 *
 * Settlement here is BATCHED: Gateway aggregates signed EIP-3009 authorizations and settles net
 * positions, so an individual payment carries a Gateway transfer id rather than its own
 * transaction hash. The page says so rather than rendering an explorer link that would 404.
 */

const SOURCE = "Circle Gateway";
const USDC_DECIMALS = 6;

/**
 * One row from GET /v1/x402/transfers.
 *
 * Field names verified against the live API 2026-09-18. They are NOT the x402 protocol's names:
 * the protocol says payTo/payer, Gateway returns toAddress/fromAddress, and the settlement hash
 * is txHash rather than transactionHash. Guessing from the protocol spec yields an object whose
 * every field reads undefined, and a monitor that silently reports nothing.
 */
interface GatewayTransfer {
  id?: string;
  status?: string;
  createdAt?: string;
  amount?: string;
  fromAddress?: string;
  toAddress?: string;
  sendingNetwork?: string;
  recipientNetwork?: string;
  /** Null until the batch carrying this payment lands onchain. */
  txHash?: string | null;
}

export interface Settlement {
  /** ISO-8601 UTC, as reported by Gateway. */
  timestamp: string | null;
  amountUsdc: number;
  /** Gateway transfer id. Batched settlement makes this the durable identifier. */
  transferId: string | null;
  /** Present only once the batch carrying this payment has landed onchain. */
  txHash: string | null;
  payer: string | null;
  /** Tool inferred from the amount when exactly one tool carries that price. */
  tool: string | null;
  /** Every tool sharing that price — populated when the amount is ambiguous. */
  toolCandidates: string[];
}

export interface MonitorSnapshot {
  payTo: string;
  network: string;
  chainName: string;
  explorer: string;
  balanceUsdc: number | null;
  /**
   * False when Gateway could not be read. The settlement figures below are then `null` rather
   * than `0` — an unreadable history and a genuinely empty one are different facts, and
   * rendering the first as the second reads as "this service has never been paid".
   */
  historyAvailable: boolean;
  settledCount: number | null;
  settledUsdc: number | null;
  lastSettledAt: string | null;
  settlements: Settlement[];
  /** Non-fatal degradations, so a partial page never masquerades as a healthy one. */
  warnings: string[];
}

/** Map a settled amount back to the tool(s) priced at exactly that value. */
export function toolsForAmount(amountUsdc: number, specs: PaidToolSpec[]): string[] {
  const atomic = Math.round(amountUsdc * 1e6);
  return specs
    .filter((s) => Math.round(Number(s.defaultPrice.replace(/^\$/, "")) * 1e6) === atomic)
    .map((s) => s.name);
}

/**
 * Normalize Gateway's transfer list into settlements. Pure; no network.
 *
 * THE ADDRESS FILTER IS LOAD-BEARING, NOT COSMETIC. Verified 2026-09-18: Gateway ignores the
 * `payTo` query parameter and returns transfers for EVERY seller on the network — a request
 * filtered to one address came back with 50 rows of which 1 was ours. Without this filter the
 * public monitor page would publish 49 strangers' payment records, complete with counterparty
 * addresses and amounts. Never remove it, and never trust the server-side filter to have
 * narrowed anything.
 */
export function toSettlements(
  items: GatewayTransfer[],
  payTo: string,
  specs: PaidToolSpec[],
): Settlement[] {
  const target = payTo.trim().toLowerCase();
  if (!target) return [];
  const out: Settlement[] = [];
  for (const t of items) {
    // Count only value arriving AT our payout address. See the note above.
    if ((t.toAddress ?? "").toLowerCase() !== target) continue;
    if (!t.amount) continue;
    const amount = Number(t.amount) / 10 ** USDC_DECIMALS;
    if (!Number.isFinite(amount)) continue;
    const candidates = toolsForAmount(amount, specs);
    out.push({
      timestamp: t.createdAt ?? null,
      amountUsdc: amount,
      transferId: t.id ?? null,
      txHash: t.txHash ?? null,
      payer: t.fromAddress ?? null,
      tool: candidates.length === 1 ? candidates[0] : null,
      toolCandidates: candidates,
    });
  }
  return out.sort((a, b) => ((a.timestamp ?? "") < (b.timestamp ?? "") ? 1 : -1));
}

/**
 * Retry only what a retry can fix: a missing status means timeout or transport failure, and 5xx
 * is the upstream's problem. A 4xx is a request we got wrong, so repeating it burns wall-clock.
 */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return false;
  return e.status === undefined || e.status >= 500;
}

const HISTORY_ATTEMPTS = 3;
const HISTORY_TIMEOUT_MS = 5_000;
const HISTORY_BACKOFF_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchTransfers(
  gatewayUrl: string,
  payTo: string,
  network: string,
  deps: { fetch?: typeof fetchJson; wait?: typeof sleep } = {},
): Promise<GatewayTransfer[]> {
  const get = deps.fetch ?? fetchJson;
  const wait = deps.wait ?? sleep;
  const url =
    `${gatewayUrl}/v1/x402/transfers?payTo=${encodeURIComponent(payTo)}` +
    `&network=${encodeURIComponent(network)}&limit=50`;
  let last: unknown;
  for (let attempt = 0; attempt < HISTORY_ATTEMPTS; attempt++) {
    try {
      const body = await get<{ transfers?: GatewayTransfer[]; data?: GatewayTransfer[] }>(url, {
        source: SOURCE,
        timeoutMs: HISTORY_TIMEOUT_MS,
      });
      return body.transfers ?? body.data ?? [];
    } catch (e) {
      last = e;
      if (!isRetryable(e) || attempt === HISTORY_ATTEMPTS - 1) break;
      await wait(HISTORY_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw last;
}

/**
 * Arc's Circle Gateway domain id.
 *
 * This is Gateway's OWN chain numbering and is unrelated to the EVM chain id (5042) or the
 * CCTP-style domains used elsewhere. Read from GET /v1/info, where Arc Mainnet and Arc Testnet
 * both report domain 26. Guessing it yields "Invalid gateway domain" and a 400.
 */
export const ARC_GATEWAY_DOMAIN = 26;

interface GatewayBalance {
  domain?: number;
  depositor?: string;
  balance?: string;
  pendingBatch?: string;
}

/**
 * The seller's Gateway balance. Keyless.
 *
 * `balance` is settled funds; `pendingBatch` is value from authorizations Gateway has accepted
 * but not yet settled onchain. Both are reported, because showing only the settled figure would
 * make freshly-earned revenue look like it had vanished.
 */
export async function fetchBalance(
  gatewayUrl: string,
  payTo: string,
  deps: { fetch?: typeof fetchJson } = {},
): Promise<number | null> {
  const get = deps.fetch ?? fetchJson;
  const body = await get<{ balances?: GatewayBalance[] }>(`${gatewayUrl}/v1/balances`, {
    source: SOURCE,
    method: "POST",
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: ARC_GATEWAY_DOMAIN, depositor: payTo }],
    }),
    timeoutMs: HISTORY_TIMEOUT_MS,
  });
  const first = body.balances?.[0];
  if (!first) return null;
  const settled = Number(first.balance ?? 0);
  const pending = Number(first.pendingBatch ?? 0);
  const total = settled + pending;
  return Number.isFinite(total) ? total : null;
}

export async function buildSnapshot(
  payTo: string,
  specs: PaidToolSpec[],
  opts: { gatewayUrl: string; network: string; chain: "arc" | "arcTestnet" },
): Promise<MonitorSnapshot> {
  const warnings: string[] = [];
  let historyAvailable = true;
  const spec = CHAINS[opts.chain];

  // Balance and history fail independently — one being down must not blank the whole page.
  const [balance, transfers] = await Promise.all([
    fetchBalance(opts.gatewayUrl, payTo).catch((e) => {
      warnings.push(`balance unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
    fetchTransfers(opts.gatewayUrl, payTo, opts.network).catch((e) => {
      warnings.push(
        `settlement history unavailable after ${HISTORY_ATTEMPTS} attempts: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      historyAvailable = false;
      return [] as GatewayTransfer[];
    }),
  ]);

  const settlements = toSettlements(transfers, payTo, specs);
  return {
    payTo,
    network: opts.network,
    chainName: spec.name,
    explorer: spec.explorer,
    balanceUsdc: balance,
    historyAvailable,
    // Null rather than 0 when unreadable — see MonitorSnapshot.historyAvailable.
    settledCount: historyAvailable ? settlements.length : null,
    settledUsdc: historyAvailable ? settlements.reduce((sum, s) => sum + s.amountUsdc, 0) : null,
    lastSettledAt: settlements[0]?.timestamp ?? null,
    settlements,
    warnings,
  };
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[ch]};`,
  );

const fmt = (n: number | null, digits = 6): string =>
  n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });

/**
 * Self-contained dashboard. Data is polled client-side from /monitor.json so the view refreshes
 * without a reload; the first snapshot is inlined so the page renders with content on first paint.
 */
export function renderMonitorHtml(snapshot: MonitorSnapshot, toolCount: number): string {
  const s = snapshot;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc Agent Toolkit — settlements</title>
<style>
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e8eaed;--dim:#9aa4b2;--line:#222831;--accent:#4ade80}
@media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#14181d;--dim:#5b6673;--line:#e4e8ee;--accent:#047857}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);
 font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:56rem;margin:0 auto}
h1{font-size:1.1rem;margin:0 0 .25rem}
.sub{color:var(--dim);margin:0 0 1.5rem;font-size:.85rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:1rem;margin-bottom:1.5rem}
.card{border:1px solid var(--line);border-radius:6px;padding:.75rem 1rem}
.k{color:var(--dim);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
.v{font-size:1.25rem;margin-top:.15rem}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{text-align:left;color:var(--dim);font-weight:400;border-bottom:1px solid var(--line);padding:.4rem .5rem}
td{padding:.4rem .5rem;border-bottom:1px solid var(--line)}
a{color:var(--accent)}
.warn{border-left:2px solid #f59e0b;padding:.5rem .75rem;margin:.5rem 0;color:var(--dim);font-size:.8rem}
.empty{color:var(--dim);padding:1.5rem 0}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Arc Agent Toolkit — live settlements</h1>
<p class="sub">${toolCount} tools · paid in USDC on ${escapeHtml(s.chainName)} · settled via Circle Nanopayments<br>
payout <a href="${escapeHtml(s.explorer)}/address/${escapeHtml(s.payTo)}" rel="noopener">${escapeHtml(s.payTo)}</a></p>
<div id="app"></div>
<script>
const TOOLS=${toolCount};
function esc(x){return String(x==null?"":x).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function num(n,d){return n==null?"—":Number(n).toLocaleString("en-US",{maximumFractionDigits:d==null?6:d});}
function render(s){
 const rows=(s.settlements||[]).map(x=>
  "<tr><td>"+esc(x.timestamp||"—")+"</td><td>$"+num(x.amountUsdc)+"</td><td>"+
  esc(x.tool|| (x.toolCandidates&&x.toolCandidates.length?x.toolCandidates.join(" | "):"—"))+
  "</td><td>"+esc(x.payer||"—")+"</td><td>"+esc(x.transferId||"—")+"</td></tr>").join("");
 const hist=s.historyAvailable;
 document.getElementById("app").innerHTML=
  '<div class="grid">'+
  '<div class="card"><div class="k">Gateway balance</div><div class="v">'+(s.balanceUsdc==null?"—":"$"+num(s.balanceUsdc))+'</div></div>'+
  '<div class="card"><div class="k">Settlements</div><div class="v">'+(hist?s.settledCount:"unreadable")+'</div></div>'+
  '<div class="card"><div class="k">Total settled</div><div class="v">'+(hist&&s.settledUsdc!=null?"$"+num(s.settledUsdc):"—")+'</div></div>'+
  '<div class="card"><div class="k">Last payment</div><div class="v" style="font-size:.85rem">'+esc(s.lastSettledAt||"—")+'</div></div>'+
  '</div>'+
  (s.warnings||[]).map(w=>'<div class="warn">'+esc(w)+'</div>').join("")+
  (!hist
    ? '<p class="empty">Settlement history could not be read from Circle Gateway just now. This is NOT the same as zero payments — the figures above are withheld rather than shown as 0.</p>'
    : (rows
      ? '<div class="wrap"><table><thead><tr><th>time</th><th>amount</th><th>tool</th><th>payer</th><th>gateway transfer id</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
        '<p class="sub" style="margin-top:1rem">Nanopayments settle in batches, so each row carries a Gateway transfer id rather than its own transaction hash.</p>'
      : '<p class="empty">No settlements yet.</p>'));
}
render(${JSON.stringify(snapshot).replace(/</g, "\\u003c")});
setInterval(async()=>{try{const r=await fetch("/monitor.json",{cache:"no-store"});if(r.ok)render(await r.json());}catch(e){}},15000);
</script>
</main></body></html>`;
}

export { fmt };
