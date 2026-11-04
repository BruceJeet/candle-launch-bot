/**
 * Launch detection from two independent sources, deduped by mint:
 *  - api:   Candle's public token list, newest first (no key).
 *  - chain: logsSubscribe on Candle's launch-curve program; an `InitializePool` instruction is a new launch.
 *           Signature polling (getSignaturesForAddress) is the fallback while the socket is down, and a slow
 *           backstop while it is up.
 * Each mint is reported once, by whichever source saw it first; the other source's sighting is recorded too,
 * so detection latency (launch tx time to sighting) is known for both.
 *
 * Chains other than Solana plug in as further sources with their own `chain` value.
 */
import { asAddress } from "../solana/base58.ts";
import { CANDLE_CURVE_PROGRAM, WSOL, candleCurve, findPda } from "../solana/pda.ts";
import { b58decode } from "../solana/base58.ts";
import { getTransaction, type Rpc } from "../solana/rpc.ts";
import { subscribeLogs, type LogsEvent, type LogsSocket } from "../solana/logs-ws.ts";
import type { Logger } from "../log.ts";

export type Source = "api" | "chain";

export interface Launch {
  chain: string;
  mint: string;
  source: Source;
  /** When the launch happened: the launch tx's block time, else Candle's row creation time (ms). */
  launchedAtMs: number | null;
  detectedAtMs: number;
  symbol?: string;
  name?: string;
  /** The token list's creator (api). */
  creator?: string;
  /** The launch transaction's fee payer (chain); on Candle often a payer wallet, not the token list's creator. */
  signer?: string;
  launchMode?: string;
  signature?: string;
  curve?: string;
  decimals?: number;
}

export interface Sighting {
  mint: string;
  source: Source;
  atMs: number;
  launchedAtMs: number | null;
  latencyMs: number | null;
}

export const TOKENS_PATH = "/api/v1/tokens?visibility=production&limit=";
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const INIT_LOG = "Program log: Instruction: InitializePool";

/** Candle token-list rows -> launches (Solana rows only; others are skipped until their source exists). */
export function fromApiRows(rows: unknown, nowMs: number): Launch[] {
  if (!Array.isArray(rows)) return [];
  const out: Launch[] = [];
  for (const r of rows as any[]) {
    const mint = asAddress(r?.mint);
    if (!mint || (r.chain && r.chain !== "solana")) continue;
    if (r.quoteMint && r.quoteMint !== WSOL) continue;
    out.push({
      chain: "solana",
      mint,
      source: "api",
      launchedAtMs: typeof r._creationTime === "number" ? Math.round(r._creationTime) : null,
      detectedAtMs: nowMs,
      symbol: typeof r.symbol === "string" ? r.symbol : undefined,
      name: typeof r.name === "string" ? r.name : undefined,
      creator: asAddress(r.creator) ?? undefined,
      launchMode: typeof r.launchMode === "string" ? r.launchMode : undefined,
      curve: asAddress(r.virtualPool) ?? undefined,
      decimals: typeof r.decimals === "number" ? r.decimals : undefined,
    });
  }
  return out;
}

function accountKeys(tx: any): string[] {
  const msg = tx?.transaction?.message;
  const keys = (msg?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k?.pubkey));
  const loaded = tx?.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
  return keys;
}

/** A transaction under Candle's curve program -> the launch it created, or null. */
export function fromLaunchTx(tx: any, signature: string, nowMs: number): Launch | null {
  const logs: string[] = tx?.meta?.logMessages ?? [];
  if (tx?.meta?.err || !logs.includes(INIT_LOG)) return null;
  const keys = accountKeys(tx);
  if (!keys.includes(CANDLE_CURVE_PROGRAM)) return null;
  for (const b of tx.meta.postTokenBalances ?? []) {
    const mint = asAddress(b?.mint);
    if (!mint || mint === WSOL) continue;
    const curve = candleCurve(mint);
    if (!keys.includes(curve)) continue;
    return {
      chain: "solana",
      mint,
      source: "chain",
      launchedAtMs: typeof tx.blockTime === "number" ? tx.blockTime * 1000 : null,
      detectedAtMs: nowMs,
      signer: keys[0],
      signature,
      curve,
      decimals: typeof b?.uiTokenAmount?.decimals === "number" ? b.uiTokenAmount.decimals : undefined,
    };
  }
  return null;
}

export function metadataPda(mint: string): string {
  const meta = b58decode(METADATA_PROGRAM);
  return findPda([new TextEncoder().encode("metadata"), meta, b58decode(mint)], METADATA_PROGRAM);
}

/** (name, symbol) from a Metaplex metadata account. */
export function readMetadata(base64: string): { name: string; symbol: string } | null {
  try {
    const d = Buffer.from(base64, "base64");
    let at = 1 + 32 + 32;
    const out: string[] = [];
    for (let i = 0; i < 2; i++) {
      const n = d.readUInt32LE(at);
      at += 4;
      if (n > 200) return null;
      out.push(d.subarray(at, at + n).toString("utf8").replace(/\0+$/, ""));
      at += n;
    }
    return { name: out[0], symbol: out[1] };
  } catch {
    return null;
  }
}

export interface DetectorDeps {
  rpc: Rpc;
  wsUrl?: string;
  apiUrl: string;
  fetch?: typeof fetch;
  log: Logger;
  now?: () => number;
  WebSocketImpl?: typeof WebSocket;
}

export interface DetectorOptions {
  api: boolean;
  chain: boolean;
  apiPollMs: number;
  chainPollMs: number;
  apiLimit: number;
}

/**
 * Collects launches; `drain()` hands the new ones to the engine. Sources run on their own timers; nothing in a
 * source can throw into the engine loop.
 */
export class Detector {
  private seen = new Map<string, Launch>();
  private sightings = new Map<string, Partial<Record<Source, Sighting>>>();
  private queue: Launch[] = [];
  private sigSeen = new Set<string>();
  private sigOrder: string[] = [];
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private socket: LogsSocket | null = null;
  private polledOnce = false;
  private inflight = new Set<string>();
  /** Signatures whose launch transaction could not be fetched yet: retried on every poll (bounded). */
  private retries = new Map<string, number>();
  private lastSigPoll = 0;
  readonly stats = { api: { polls: 0, errors: 0, lastOkMs: 0 }, chain: { events: 0, polls: 0, errors: 0, wsUp: false, lastOkMs: 0 } };
  private deps: DetectorDeps;
  private opts: DetectorOptions;
  private now: () => number;

  constructor(deps: DetectorDeps, opts: DetectorOptions) {
    this.deps = deps;
    this.opts = opts;
    this.now = deps.now ?? Date.now;
  }

  /** Prime both sources with what exists now (marked seen, never reported) and start watching. */
  async start(): Promise<void> {
    if (this.opts.chain) {
      await this.pollSignatures(true).catch(() => undefined);
      if (this.deps.wsUrl) {
        this.socket = subscribeLogs(
          this.deps.wsUrl,
          CANDLE_CURVE_PROGRAM,
          {
            onLogs: (e) => void this.onLogs(e),
            onState: (up, why) => {
              this.stats.chain.wsUp = up;
              this.deps.log.info(up ? "chain_ws_up" : "chain_ws_down", why ? { why } : {});
            },
          },
          { WebSocketImpl: this.deps.WebSocketImpl },
        );
      }
      // Poll fast while the socket is down, slowly as a backstop while it is up.
      this.timers.push(
        setInterval(() => {
          const every = this.stats.chain.wsUp ? this.opts.chainPollMs : Math.min(this.opts.chainPollMs, 3000);
          if (this.now() - this.lastSigPoll >= every) void this.pollSignatures(false).catch(() => undefined);
        }, 1000),
      );
    }
    if (this.opts.api) {
      await this.pollApi().catch(() => undefined);
      this.timers.push(setInterval(() => void this.pollApi().catch(() => undefined), this.opts.apiPollMs));
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.socket?.close();
  }

  drain(): Launch[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  sightingsFor(mint: string): Partial<Record<Source, Sighting>> {
    return this.sightings.get(mint) ?? {};
  }

  /** Record a sighting; returns the launch when this is the first time the mint is seen. */
  offer(l: Launch, opts: { prime?: boolean } = {}): Launch | null {
    const prev = this.seen.get(l.mint);
    const s = this.sightings.get(l.mint) ?? {};
    if (!s[l.source]) {
      const launchedAtMs = l.source === "chain" ? l.launchedAtMs : (prev?.source === "chain" ? prev.launchedAtMs : l.launchedAtMs);
      s[l.source] = { mint: l.mint, source: l.source, atMs: l.detectedAtMs, launchedAtMs, latencyMs: launchedAtMs ? l.detectedAtMs - launchedAtMs : null };
      this.sightings.set(l.mint, s);
      // Latency is measured from the launch transaction's block time for every source: when the chain's time
      // arrives after the api sighting (which used Candle's row time), recompute the api sighting from it.
      if (l.source === "chain" && l.launchedAtMs && s.api) {
        s.api.launchedAtMs = l.launchedAtMs;
        s.api.latencyMs = s.api.atMs - l.launchedAtMs;
      }
      if (!opts.prime && prev) this.deps.log.info("launch_seen_again", { mint: l.mint, source: l.source, latencyMs: s[l.source]!.latencyMs, firstSource: prev.source });
    }
    if (prev) {
      // Fill in what the first sighting lacked (the chain has no launch mode; the api has no signature).
      for (const k of ["symbol", "name", "creator", "signer", "launchMode", "signature", "curve", "decimals"] as const) if (prev[k] === undefined && l[k] !== undefined) (prev as any)[k] = l[k];
      if (l.source === "chain" && l.launchedAtMs) prev.launchedAtMs = l.launchedAtMs;
      return null;
    }
    this.seen.set(l.mint, l);
    if (opts.prime) return null;
    this.queue.push(l);
    return l;
  }

  get(mint: string): Launch | undefined {
    return this.seen.get(mint);
  }

  async pollApi(): Promise<void> {
    const f = this.deps.fetch ?? fetch;
    this.stats.api.polls++;
    try {
      const res = await f(this.deps.apiUrl + TOKENS_PATH + this.opts.apiLimit, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as any;
      const rows = Array.isArray(body) ? body : body?.payload;
      // Not primed: rows that were already there at start reach the filter and fail its age check once each.
      for (const l of fromApiRows(rows, this.now())) this.offer(l);
      this.stats.api.lastOkMs = this.now();
    } catch (e) {
      this.stats.api.errors++;
      if (this.stats.api.errors % 20 === 1) this.deps.log.warn("api_poll_failed", { error: String((e as Error).message ?? e), errors: this.stats.api.errors });
    }
  }

  private markSig(sig: string): boolean {
    if (this.sigSeen.has(sig)) return false;
    this.sigSeen.add(sig);
    this.sigOrder.push(sig);
    if (this.sigOrder.length > 5000) this.sigSeen.delete(this.sigOrder.shift()!);
    return true;
  }

  private async onLogs(e: LogsEvent): Promise<void> {
    this.stats.chain.events++;
    // Every signature the socket delivers is marked, so the poller only fetches what the socket missed.
    const fresh = this.markSig(e.signature);
    if (!fresh || e.err || !e.logs.includes(INIT_LOG)) return;
    await this.fetchLaunch(e.signature);
  }

  private async fetchLaunch(sig: string): Promise<void> {
    if (this.inflight.has(sig)) return;
    this.inflight.add(sig);
    try {
      // A just-confirmed transaction can take a moment to be served by getTransaction.
      for (let i = 0; i < 3; i++) {
        let tx: any = null;
        try {
          tx = await getTransaction(this.deps.rpc, sig);
        } catch {
          tx = null;
        }
        if (tx) {
          this.retries.delete(sig);
          const l = fromLaunchTx(tx, sig, this.now());
          if (l) {
            await this.enrich(l);
            this.stats.chain.lastOkMs = this.now();
            this.offer(l);
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
      this.stats.chain.errors++;
      const n = (this.retries.get(sig) ?? 0) + 1;
      if (n <= 5) this.retries.set(sig, n);
      else this.retries.delete(sig);
      this.deps.log.warn("chain_tx_unavailable", { signature: sig, tries: n, willRetry: n <= 5 });
    } finally {
      this.inflight.delete(sig);
    }
  }

  private async enrich(l: Launch): Promise<void> {
    try {
      const r = await this.deps.rpc.call<any>("getAccountInfo", [metadataPda(l.mint), { encoding: "base64", commitment: "confirmed" }]);
      const md = r?.value?.data?.[0] ? readMetadata(r.value.data[0]) : null;
      if (md) {
        l.name = md.name;
        l.symbol = md.symbol;
      }
    } catch {
      /* name/symbol stay unknown; filters that need them wait or refuse */
    }
  }

  private polling = false;

  /** Signature polling: the fallback while the socket is down, and a backstop while it is up. */
  async pollSignatures(prime: boolean): Promise<void> {
    // Single flight: a slow poll is never joined by a second one that would fetch the same transactions.
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollSignaturesOnce(prime);
    } finally {
      this.polling = false;
    }
  }

  private async pollSignaturesOnce(prime: boolean): Promise<void> {
    this.stats.chain.polls++;
    this.lastSigPoll = this.now();
    const sigs: any[] = [];
    try {
      // Page back with `before` until a page reaches a signature already seen (or 5 pages): a burst of more than
      // one page between polls is not skipped.
      let before: string | undefined;
      for (let page = 0; page < (prime ? 1 : 5); page++) {
        const got = (await this.deps.rpc.call<any[]>("getSignaturesForAddress", [CANDLE_CURVE_PROGRAM, { limit: prime ? 100 : 50, commitment: "confirmed", ...(before ? { before } : {}) }])) ?? [];
        sigs.push(...got);
        if (got.length < (prime ? 100 : 50) || got.some((x) => this.sigSeen.has(x?.signature))) break;
        before = got[got.length - 1]?.signature;
        if (!before) break;
      }
    } catch (e) {
      this.stats.chain.errors++;
      return;
    }
    for (const sig of [...this.retries.keys()]) await this.fetchLaunch(sig);
    const fresh = sigs.filter((s) => s && typeof s.signature === "string" && !s.err).reverse();
    if (prime || !this.polledOnce) {
      for (const s of fresh) this.markSig(s.signature);
      this.polledOnce = true;
      return;
    }
    for (const s of fresh) {
      if (!this.markSig(s.signature)) continue;
      // No logs on this path: fetch each unseen transaction (the program's traffic is light).
      await this.fetchLaunch(s.signature);
    }
  }
}
