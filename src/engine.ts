/**
 * The engine loop. Each cycle:
 *   controls (STOP, PAUSE_BUYS, manual sell requests) -> new launches through the filters -> buys ->
 *   one executor sweep -> market reads for open positions -> exit strategy -> sells -> status.json
 * Nothing in a cycle can throw out of the loop; the control files are read first and never block.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Detector, Launch } from "./detect/detector.ts";
import { Executor } from "./exec/executor.ts";
import { evaluate, lamportsOf } from "./filters.ts";
import type { Ledger, PositionRow } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { decodeCandleCurve, type CandleCurve } from "./market/curve.ts";
import { readMarkets, type MarketRead } from "./market/reader.ts";
import { redactDeep } from "./redact.ts";
import { candleCurve } from "./solana/pda.ts";
import { tokenBalance, type Rpc } from "./solana/rpc.ts";
import type { ExitStrategy, PositionView } from "./strategies/types.ts";
import type { Alerter } from "./alerts.ts";

export interface MarketInfoSource {
  /**
   * Candle's public market record: launch mode (`tier`), name/symbol and decimals for a chain-first launch, and
   * whether Candle has the market at all (`candleLaunched`, `trade.routable`).
   */
  getMarket(chain: "solana", mint: string): Promise<any>;
}

/** How often a chain-first launch's Candle market is re-read while the bot waits for it (Candle caches ~5 s). */
export const MARKET_CHECK_MS = 2_000;
/** The verdict reason while a launch Candle cannot trade waits, and the skip reason when it ages out. */
export const NO_CANDLE_MARKET = "no Candle market";

/**
 * Does Candle's market record say Candle has this market and can route a trade on it? Candle answers 200 for every
 * mint, with `candleLaunched: false` for an unknown one or one launched with non-production visibility, so only an
 * explicit `candleLaunched: true` passes; `trade.routable: false` refuses. Anything else (missing fields, an older
 * API) is unknown, and unknown never passes.
 */
export function candleHasMarket(m: any): { ok: true } | { ok: false; why: string } {
  if (!m || typeof m !== "object") return { ok: false, why: "no market record" };
  if (m.candleLaunched !== true) return { ok: false, why: m.candleLaunched === false ? "not a Candle market" : "candleLaunched unknown" };
  if (m.trade && m.trade.routable === false) return { ok: false, why: `not routable${m.trade.reason ? ` (${m.trade.reason})` : ""}` };
  return { ok: true };
}

export interface EngineDeps {
  cfg: Config;
  ledger: Ledger;
  detector: Detector;
  executor: Executor;
  strategy: ExitStrategy;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  markets?: MarketInfoSource | null;
  now?: () => number;
}

/** Most time one cycle spends before the rest of its work waits for the next one (exits always run). */
export const CYCLE_BUDGET_MS = 20_000;
/** Candle's market record while filtering a launch: a slow answer must not hold the loop. */
export const MARKET_READ_TIMEOUT_MS = 3_000;

/** How often the wallet's balance of each held coin is compared with what this bot booked. */
export const SURPLUS_CHECK_MS = 600_000;
/** Coins whose position ended this recently are still checked for a surplus. */
export const SURPLUS_TAIL_MS = 3_600_000;
/** A DAMM v2 pool this close to its floor has no liquidity left to sell into. */
export const FLOOR_ROOM_MIN = 0.005;

interface Pending {
  launch: Launch;
  firstSeenMs: number;
  lastReason: string;
  marketTried: number;
  /** The launch mode came from Candle's market read (not from Candle's token list). */
  modeFromMarket?: boolean;
  /** Candle's market record said it has this market (see candleHasMarket). */
  marketOk?: boolean;
  /** When the market was last read, and why the last read did not pass. */
  marketCheckedAt?: number;
  marketWhy?: string;
}

const DEFAULT_DECIMALS = 6;

/** Read a control file without ever blocking or throwing: regular files only, non-blocking open, bounded read. */
export function readControl(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

export class Engine {
  private d: EngineDeps;
  private now: () => number;
  private pending = new Map<string, Pending>();
  private exitHoldUntil = new Map<number, number>();
  /** When each position's exits were first held for want of a sell route (cleared once a route is back). */
  private noRouteSince = new Map<number, number>();
  /** Next surplus check per coin. */
  private surplusAt = new Map<string, number>();
  private surplusSeen = new Set<string>();
  private markets = new Map<string, MarketRead>();
  private stopRequested = false;
  private cycles = 0;
  private lastCycleMs = 0;
  readonly stats = { launches: 0, buys: 0, skips: 0, sells: 0 };

  constructor(d: EngineDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    mkdirSync(join(d.cfg.stateDir, "requests"), { recursive: true });
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  paused(): boolean {
    return readControl(join(this.d.cfg.stateDir, "PAUSE_BUYS")) !== null;
  }

  /** STOP file or SIGTERM/SIGINT: checked before every step and between orders. */
  shouldStop = (): boolean => {
    if (!this.stopRequested && readControl(join(this.d.cfg.stateDir, "STOP")) !== null) {
      this.d.log.info("stop_file_seen");
      this.stopRequested = true;
    }
    return this.stopRequested;
  };

  /** Each cycle has a time budget; work left over waits for the next cycle. */
  private overBudget(t0: number): boolean {
    return this.now() - t0 > CYCLE_BUDGET_MS;
  }

  /** One full cycle. Returns false when STOP was seen (the caller exits cleanly). */
  async cycle(): Promise<boolean> {
    const t0 = this.now();
    const sweep = (side?: "buy" | "sell", reconcileOnly = false) => this.d.executor.sweep(5, { side, reconcileOnly, budgetMs: Math.max(1_000, CYCLE_BUDGET_MS - (this.now() - t0)), shouldStop: this.shouldStop });
    // Exits first: a stop-loss never waits behind new entries.
    const steps: Array<[string, () => Promise<void>]> = [
      ["requests", () => this.manualRequests()],
      ["sells", () => sweep("sell")],
      ["exits", () => this.exits()],
      ["sells2", () => sweep("sell")],
      // Buys that may already have executed get their own slot: settling them never waits behind a slow sell side.
      ["settle-buys", () => sweep("buy", true)],
      ["entries", () => this.entries(t0)],
      ["orders", () => sweep()],
      ["nag", async () => this.nag()],
      ["surplus", () => this.surplus()],
    ];
    for (const [name, fn] of steps) {
      if (this.shouldStop()) {
        this.writeStatus();
        return false;
      }
      // Past the budget only the exit steps still run.
      if (this.overBudget(t0) && !["sells", "exits", "sells2", "settle-buys", "nag"].includes(name)) continue;
      await this.guard(name, fn);
    }
    if (this.shouldStop()) {
      this.writeStatus();
      return false;
    }
    this.cycles++;
    this.lastCycleMs = this.now() - t0;
    this.writeStatus();
    return true;
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.d.log.error("cycle_step_failed", { step: what, error: String((e as Error)?.stack ?? e) });
    }
  }

  /** Conditions that need a human re-announce (alerts.renotifyMs) until they clear. */
  private nag(): void {
    for (const p of this.mine("exit_stuck"))
      this.d.alerter.raise(`position:${p.id}:exit_stuck`, `position ${p.id} ${p.mint}: exits refused ${p.exit_orders_failed} times; retried every ${Math.round(this.d.cfg.retry.stuckRetryMs / 60000)} min, or run \`sell\` by hand`);
    for (const p of this.mine("opening", "open", "exit_stuck")) {
      const o = this.d.ledger.openOrderFor(p.id);
      if (o && o.tx_read_failures >= 6) this.d.alerter.raise(`order:${o.id}:qty_unknown`, `order ${o.id} ${o.side} ${p.mint} landed but its fill is still unread`);
    }
  }

  /**
   * The wallet holding more of a coin than this bot booked (a second execution that landed after the first was booked,
   * or tokens from elsewhere): alerted, never adopted. Checked per coin every SURPLUS_CHECK_MS, while no order of the
   * coin is in flight.
   */
  private async surplus(): Promise<void> {
    if (this.dry) return;
    const held = this.mine("opening", "open", "exit_stuck");
    // Also coins whose position ended within the last hour: a late second execution can outlive the position.
    const recent = this.mine("closed", "failed").filter((p) => p.closed_at !== null && this.now() - p.closed_at < SURPLUS_TAIL_MS);
    const mints = [...new Set([...held, ...recent].map((p) => p.mint))];
    for (const mint of mints) {
      if (this.shouldStop()) return;
      if ((this.surplusAt.get(mint) ?? 0) > this.now()) continue;
      const ps = held.filter((p) => p.mint === mint);
      if (ps.some((p) => p.status === "opening" || this.d.ledger.openOrderFor(p.id))) continue;
      this.surplusAt.set(mint, this.now() + SURPLUS_CHECK_MS);
      const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, mint);
      if (bal === null) continue;
      const booked = ps.reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
      if (bal <= booked) {
        this.surplusSeen.delete(mint);
        continue;
      }
      // Two readings in a row (a minute apart), so one lagging read after a sell is not an alarm.
      if (!this.surplusSeen.has(mint)) {
        this.surplusSeen.add(mint);
        this.surplusAt.set(mint, this.now() + 60_000);
        continue;
      }
      this.d.alerter.raise(`coin:${mint}:surplus`, `${mint}: the wallet holds ${bal} tokens, ${bal - booked} more than this bot booked${ps.length ? ` (positions ${ps.map((p) => p.id).join(", ")})` : " (no open position)"}; not managed, \`sell\` reaches a failed buy's own`);
    }
  }

  // ---------------------------------------------------------------- entries
  private get dry(): boolean {
    return this.d.cfg.mode === "dry";
  }

  /** Positions of this run's mode only: a dry run never manages live rows, a live run never dry ones. */
  private mine(...statuses: Parameters<Ledger["positionsByStatus"]>): PositionRow[] {
    return this.d.ledger.positionsByStatus(...statuses).filter((p) => !!p.dry === this.dry);
  }

  private openCount(): number {
    return this.mine("opening", "open", "exit_stuck").length;
  }

  private async entries(t0: number = this.now()): Promise<void> {
    for (const l of this.d.detector.drain()) {
      this.stats.launches++;
      const s = this.d.detector.sightingsFor(l.mint)[l.source];
      this.d.log.info("launch_detected", { mint: l.mint, source: l.source, symbol: l.symbol, mode: l.launchMode, latencyMs: s?.latencyMs ?? null, signature: l.signature });
      this.pending.set(l.mint, { launch: l, firstSeenMs: this.now(), lastReason: "", marketTried: 0 });
    }
    for (const [mint, p] of [...this.pending]) {
      if (this.shouldStop() || this.overBudget(t0)) break;
      const l = this.d.detector.get(mint) ?? p.launch;
      const v = await this.decide(l, p);
      const sights = this.d.detector.sightingsFor(mint);
      if (v.verdict === "wait") {
        if (v.reason !== p.lastReason) this.d.log.info("launch_wait", { mint, reason: v.reason, ...(v.reason === NO_CANDLE_MARKET ? { market: p.marketWhy ?? null } : {}) });
        p.lastReason = v.reason;
        continue;
      }
      this.pending.delete(mint);
      this.d.ledger.recordLaunch({
        mint, chain: l.chain, first_source: l.source, first_seen_at: l.detectedAtMs, launched_at: l.launchedAtMs,
        api_seen_at: sights.api?.atMs ?? null, chain_seen_at: sights.chain?.atMs ?? null,
        api_latency_ms: sights.api?.latencyMs ?? null, chain_latency_ms: sights.chain?.latencyMs ?? null,
        symbol: l.symbol ?? null, name: l.name ?? null, creator: l.creator ?? l.signer ?? null, launch_mode: l.launchMode ?? null,
        decision: v.verdict, reason: v.verdict === "skip" ? v.reason : `impact ${v.impactBps} bps`,
      });
      if (v.verdict === "skip") {
        this.stats.skips++;
        this.d.log.info("launch_skip", { mint, symbol: l.symbol, reason: v.reason });
        continue;
      }
      this.buy(l, v.impactBps, v.expectedOutRaw);
    }
    // Keep the latency record current for launches decided before the slower source saw them.
    for (const row of this.d.ledger.recentLaunches(10)) {
      const s = this.d.detector.sightingsFor(row.mint);
      if ((s.api && (row.api_seen_at === null || row.api_latency_ms !== s.api.latencyMs)) || (s.chain && row.chain_seen_at === null)) {
        this.d.ledger.recordLaunch({ ...row, api_seen_at: s.api?.atMs ?? null, chain_seen_at: s.chain?.atMs ?? null, api_latency_ms: s.api?.latencyMs ?? null, chain_latency_ms: s.chain?.latencyMs ?? null, decision: null, reason: null });
      }
    }
  }

  private async decide(l: Launch, p: Pending) {
    const v = await this.verdict(l, p);
    // A launch that waited for its Candle market and aged out is skipped for that reason, not just its age.
    if (v.verdict === "skip" && p.lastReason === NO_CANDLE_MARKET && /^age /.test(v.reason)) {
      this.d.log.info("launch_no_market", { mint: l.mint, why: p.marketWhy ?? null });
      return { verdict: "skip" as const, reason: NO_CANDLE_MARKET };
    }
    // A launch whose mode Candle's token list did not give (inferred from the curve, or read from Candle's market
    // record) is bought only once Candle's market record says Candle has the market: otherwise every build is refused
    // (MARKET_NOT_FOUND). A launch from Candle's list never waits here and costs no extra call.
    if (v.verdict === "buy" && (!l.launchMode || p.modeFromMarket) && !p.marketOk) {
      if (this.d.markets && (p.marketCheckedAt === undefined || this.now() - p.marketCheckedAt >= MARKET_CHECK_MS)) {
        p.marketCheckedAt = this.now();
        try {
          this.noteMarket(p, await this.readMarket(l.mint));
        } catch (e) {
          p.marketWhy = `market read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
        }
      } else if (!this.d.markets) p.marketWhy = "no market source";
      if (!p.marketOk) return { verdict: "wait" as const, reason: NO_CANDLE_MARKET };
    }
    return v;
  }

  private readMarket(mint: string): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.d.markets!.getMarket("solana", mint),
      new Promise<never>((_r, rej) => (timer = setTimeout(() => rej(new Error("market read timeout")), MARKET_READ_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer));
  }

  private noteMarket(p: Pending, m: any): void {
    const has = candleHasMarket(m);
    if (has.ok) {
      p.marketOk = true;
      p.marketWhy = undefined;
    } else p.marketWhy = has.why;
  }

  private async verdict(l: Launch, p: Pending) {
    const caps = { open: this.openCount(), entriesForMint: this.d.ledger.entriesForMint(l.mint, this.dry), lifetimeLamports: this.d.ledger.lifetimeBuyLamports(this.d.cfg.mode === "dry"), paused: this.paused() };
    let v = evaluate(this.d.cfg, l, null, caps, this.now());
    if (v.verdict === "wait" && /mode unknown|name unknown|symbol unknown|creator unknown/.test(v.reason) && this.d.markets && p.marketTried < 10) {
      p.marketTried++;
      try {
        const m = await this.readMarket(l.mint);
        p.marketCheckedAt = this.now();
        this.noteMarket(p, m);
        if (m?.tier && !l.launchMode) {
          l.launchMode = String(m.tier);
          p.modeFromMarket = true;
        }
        if (m?.metadata?.name && l.name === undefined) l.name = String(m.metadata.name);
        if (m?.metadata?.symbol && l.symbol === undefined) l.symbol = String(m.metadata.symbol);
        if (typeof m?.decimals === "number" && l.decimals === undefined) l.decimals = m.decimals;
      } catch {
        /* not indexed yet: the next cycle asks again */
      }
      v = evaluate(this.d.cfg, l, null, caps, this.now());
    }
    if (v.verdict !== "wait" || v.reason !== "curve not readable yet") return v;
    let curve: CandleCurve | "unreadable" | null = null;
    try {
      const r = await this.d.rpc.call<any>("getAccountInfo", [l.curve ?? candleCurve(l.mint), { encoding: "base64", commitment: "confirmed" }]);
      curve = r?.value ? decodeCandleCurve(r.value) : null;
    } catch (e) {
      curve = /owner|layout/.test(String((e as Error).message)) ? "unreadable" : null;
    }
    return evaluate(this.d.cfg, l, curve, caps, this.now());
  }

  private buy(l: Launch, impactBps: number, expectedOutRaw: bigint): void {
    const now = this.now();
    const dry = this.d.cfg.mode === "dry";
    const lamports = lamportsOf(this.d.cfg.buy.sol);
    const id = this.d.ledger.tx(() => {
      const pid = this.d.ledger.createPosition({ mint: l.mint, chain: l.chain, dry, now, decimals: l.decimals ?? DEFAULT_DECIMALS, strategy: this.d.strategy.name, launch: l });
      // The buy is only good while the filter's decision is: no attempt is built past the coin's max age.
      const deadlineAt = (l.launchedAtMs ?? now) + this.d.cfg.filters.maxAgeSec * 1000;
      this.d.ledger.createOrder({ positionId: pid, side: "buy", clientTradeId: `clb-${randomUUID()}`, amountRaw: lamports, slippageBps: this.d.cfg.buy.maxSlippageBps, maxAttempts: this.d.cfg.retry.maxAttempts, now, reason: `entry, impact ${impactBps} bps`, deadlineAt, expectedOutRaw });
      return pid;
    });
    this.stats.buys++;
    this.d.log.info(dry ? "dry_buy" : "buy_order", { position: id, mint: l.mint, symbol: l.symbol, sol: this.d.cfg.buy.sol, impactBps, ageMs: l.launchedAtMs ? now - l.launchedAtMs : null });
  }

  // ---------------------------------------------------------------- exits
  private view(p: PositionRow, m: MarketRead): PositionView {
    const qty = BigInt(p.qty_raw);
    const rem = BigInt(p.remaining_raw);
    // Tokens written off for a wallet shortfall were never sold: they leave both sides of soldFraction.
    const base = qty - BigInt(p.written_down_raw ?? "0");
    const entry = qty > 0n ? Number(BigInt(p.cost_lamports)) / 1e9 / (Number(qty) / 10 ** p.decimals) : 0;
    return {
      mint: p.mint,
      openedAtMs: p.opened_at,
      qtyRaw: qty,
      remainingRaw: rem,
      decimals: p.decimals,
      entryPriceSol: entry,
      peakPriceSol: Math.max(p.peak_price, m.priceSol ?? 0),
      soldFraction: base > 0n ? Math.max(0, Number(base - rem) / Number(base)) : 0,
    };
  }

  private async exits(): Promise<void> {
    const open = this.mine("open", "exit_stuck");
    if (!open.length) return;
    this.markets = await readMarkets(this.d.rpc, open.map((p) => ({ mint: p.mint, decimals: p.decimals })), this.now());
    for (const p of open) {
      const m = this.markets.get(p.mint);
      if (!m) continue;
      if (m.priceSol !== null) this.d.ledger.updatePosition(p.id, { last_price: m.priceSol, peak_price: Math.max(p.peak_price, m.priceSol) });
      if (this.shouldStop()) return;
      // exit_stuck: refused repeatedly. Not permanent: one more try on the slow clock (the alert keeps nagging).
      if (p.status === "exit_stuck") {
        const lastSell = this.d.ledger.ordersFor(p.id).filter((o) => o.side === "sell").pop();
        if (lastSell && this.now() < lastSell.updated_at + this.d.cfg.retry.stuckRetryMs) continue;
      }
      if (this.d.ledger.openOrderFor(p.id)) continue;               // one exit in flight at a time
      if ((this.exitHoldUntil.get(p.id) ?? 0) > this.now()) continue;
      // No sell route right now: migrating to its pool, unreadable, or a pool at its floor. Hold; don't burn exits.
      if (m.problem || m.priceSol === null || (m.venue === "damm" && m.roomAboveFloor !== null && m.roomAboveFloor < FLOOR_ROOM_MIN)) {
        const why = m.problem ?? (m.priceSol === null ? "no price" : "pool at its floor");
        if (this.d.ledger.alert(`position:${p.id}:no_route:${why}`, `position ${p.id} ${p.mint}: exits held (${why})`, this.now(), 3_600_000)) this.d.log.info("exit_held", { position: p.id, mint: p.mint, why });
        // A short hold is normal (migration takes a few slots); one that lasts reaches the alert sinks, renotified.
        const since = this.noRouteSince.get(p.id) ?? this.now();
        if (!this.noRouteSince.has(p.id)) this.noRouteSince.set(p.id, since);
        const held = this.now() - since;
        if (held >= this.d.cfg.alerts.holdAlertMs) this.d.alerter.raise(`position:${p.id}:no_route`, `position ${p.id} ${p.mint}: no sell route for ${Math.round(held / 60_000)} min (${why}); exits held`);
        continue;
      }
      this.noRouteSince.delete(p.id);
      // After failed exit orders (refused or out of attempts), the next waits on the position's own backoff clock.
      const sells = this.d.ledger.ordersFor(p.id).filter((o) => o.side === "sell");
      let streak = 0;
      for (let i = sells.length - 1; i >= 0 && ["failed", "rejected", "reverted"].includes(sells[i].status); i--) streak++;
      if (streak > 0 && p.status !== "exit_stuck" && this.now() < sells[sells.length - 1].updated_at + this.d.executor.backoffMs(streak + 1)) continue;
      let decision;
      try {
        decision = this.d.strategy.onTick(this.view(p, m), m);
      } catch (e) {
        this.d.log.error("strategy_error", { position: p.id, error: String((e as Error)?.message ?? e) });
        continue;
      }
      if (decision.action !== "sell") continue;
      await this.placeSell(p, decision.fraction, decision.reason, false);
    }
  }

  /** Create a sell order clamped to the on-chain balance. Returns the order id, or null when refused. */
  async placeSell(p: PositionRow, fraction: number, reason: string, manual: boolean): Promise<number | null> {
    p = this.d.ledger.position(p.id) ?? p;
    if (!(fraction > 0 && fraction <= 1)) throw new Error("fraction must be in (0, 1]");
    let remaining = BigInt(p.remaining_raw);
    if (remaining <= 0n) return null;
    const part = (x: bigint) => (fraction >= 1 ? x : (x * BigInt(Math.round(fraction * 1e6))) / 1_000_000n);
    if (part(remaining) <= 0n) return null;
    if (!p.dry) {
      const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, p.mint);
      const refuse = (why: "unreadable" | "zero") => {
        // Zero or unreadable: the tokens are gone or this is the wrong account. Never sell for nothing.
        this.exitHoldUntil.set(p.id, this.now() + 60_000);
        const key = `position:${p.id}:balance:${why}`;
        this.d.alerter.raise(key, `sell refused for position ${p.id} ${p.mint}: wallet balance ${why}`);
        return null;
      };
      if (bal === null) return refuse("unreadable");
      // Other open positions of this bot in the same coin own part of the balance.
      const others = this.mine("open", "exit_stuck", "opening").filter((x) => x.mint === p.mint && x.id !== p.id).reduce((s, x) => s + BigInt(x.remaining_raw), 0n);
      const available = bal - others;
      if (available <= 0n) return refuse("zero");
      if (available < remaining) {
        // The wallet holds less than the ledger says: write the position down to what is really there (only ever
        // down), so a sell of it can close the position instead of leaving a phantom remainder forever.
        this.d.ledger.updatePosition(p.id, { remaining_raw: available.toString(), written_down_raw: (BigInt(p.written_down_raw ?? "0") + remaining - available).toString(), note: `shortfall: ledger ${remaining}, wallet ${available}` });
        const key = `position:${p.id}:shortfall`;
        this.d.alerter.raise(key, `position ${p.id} ${p.mint}: wallet holds ${available} of ${remaining} booked`);
        this.d.log.warn("sell_clamped", { position: p.id, mint: p.mint, bookedRaw: remaining, balanceRaw: available });
        remaining = available;
      }
    }
    const amount = part(remaining);
    if (amount <= 0n) return null;
    const now = this.now();
    const id = this.d.ledger.createOrder({ positionId: p.id, side: "sell", clientTradeId: `cls-${randomUUID()}`, amountRaw: amount, slippageBps: this.d.cfg.sell.maxSlippageBps, maxAttempts: this.d.cfg.retry.maxAttempts, now, reason, manual });
    this.stats.sells++;
    this.d.log.info(p.dry ? "dry_sell" : "sell_order", { position: p.id, mint: p.mint, amountRaw: amount, fraction, reason, manual });
    return id;
  }

  // ---------------------------------------------------------------- manual requests (from the `sell` command)
  private async manualRequests(): Promise<void> {
    const dir = join(this.d.cfg.stateDir, "requests");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^sell-[A-Za-z0-9-]+\.json$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const path = join(dir, n);
      const text = readControl(path);
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
      if (!text) continue;
      try {
        const req = JSON.parse(text) as { mint: string; fraction: number };
        const r = await this.manualSell(req.mint, req.fraction);
        this.d.log.info("manual_sell_request", { mint: req.mint, fraction: req.fraction, result: r });
      } catch (e) {
        this.d.log.warn("manual_sell_request_bad", { file: n, error: String((e as Error).message) });
      }
    }
  }

  /** The `sell` command's path: same clamp, same executor. Moves an exit_stuck position back to open. */
  async manualSell(mint: string, fraction: number): Promise<string> {
    let p = this.mine("open", "exit_stuck").find((x) => x.mint === mint);
    if (!p) {
      const r = await this.reopenFailedBuy(mint);
      if (typeof r === "string") return r;
      p = r;
    }
    if (this.d.ledger.openOrderFor(p.id)) return "an exit order is already in flight";
    // exit_stuck is cleared only when this manual sell fills (the executor does that), not before.
    const id = await this.placeSell(p, fraction, "manual", true);
    return id === null ? "refused (see alerts)" : `order ${id}`;
  }

  /**
   * `sell` on a coin whose buy ended failed or rejected while the wallet holds its tokens (a buy that landed after the
   * bot gave up, or that it could not prove): reopen that position with the wallet's unexplained tokens (qty from the
   * wallet, cost the order's ticket) so the sell can run. Only buys that may have executed qualify. Alerted.
   */
  private async reopenFailedBuy(mint: string): Promise<PositionRow | string> {
    const dry = this.d.cfg.mode === "dry";
    const cand = this.d.ledger.positionsByStatus("failed").filter((x) => x.mint === mint && !!x.dry === dry).pop();
    const buy = cand ? this.d.ledger.ordersFor(cand.id).find((o) => o.side === "buy") : undefined;
    // Only a buy that ended failed or rejected and may have run: a revert delivered nothing, a filled buy was booked.
    if (!cand || !buy || !["failed", "rejected"].includes(buy.status) || !(buy.ever_signed === 1 || buy.signature) || BigInt(cand.qty_raw) > 0n) return "no open position for that mint";
    if (dry) return "no open position for that mint";
    const r = await this.d.executor.reopenable(buy.id);
    if ("why" in r) return `no open position for that mint (${r.why})`;
    this.d.ledger.tx(() => {
      this.d.ledger.updatePosition(cand.id, { status: "open", closed_at: null, qty_raw: r.amount.toString(), remaining_raw: r.amount.toString(), qty_source: r.signatures.length ? "onchain" : "wallet", cost_lamports: r.costLamports.toString(), note: `reopened by sell: ${r.amount} tokens received since the buy (ended ${buy.status})` });
      // Our transactions, once found, are booked to the buy so no other scan claims them.
      if (r.signatures.length) this.d.ledger.updateOrder(buy.id, { status: "filled", signature: r.signatures[0], extra_signatures: r.signatures.length > 1 ? JSON.stringify(r.signatures.slice(1)) : null });
    });
    this.d.alerter.raise(`position:${cand.id}:reopened`, `position ${cand.id} ${mint}: buy ended ${buy.status}; reopened with ${r.amount} tokens received since the order (${r.signatures.length ? `our tx ${r.signatures.join(", ")}` : "no tx of ours found; capped, cost the ticket"}) for the manual sell`);
    return this.d.ledger.position(cand.id)!;
  }

  // ---------------------------------------------------------------- status.json
  statusObject(): Record<string, unknown> {
    const now = this.now();
    const dry = this.d.cfg.mode === "dry";
    const all = this.d.ledger.allPositions().filter((p) => !!p.dry === dry);
    let spent = 0n, proceeds = 0n, fees = 0n, rent = 0n, openValue = 0;
    const open: unknown[] = [];
    for (const p of all) {
      spent += BigInt(p.cost_lamports);
      proceeds += BigInt(p.proceeds_lamports);
      fees += BigInt(p.network_fees_lamports);
      rent += BigInt(p.rent_lamports ?? "0");
      if (p.status === "open" || p.status === "exit_stuck" || p.status === "opening") {
        const m = this.markets.get(p.mint);
        const price = m?.priceSol ?? p.last_price ?? null;
        const remaining = BigInt(p.remaining_raw);
        const value = price === null ? null : (Number(remaining) / 10 ** p.decimals) * price;
        if (value !== null) openValue += value;
        const qty = BigInt(p.qty_raw);
        const entry = qty > 0n ? Number(BigInt(p.cost_lamports)) / 1e9 / (Number(qty) / 10 ** p.decimals) : null;
        open.push({ id: p.id, mint: p.mint, status: p.status, openedAt: new Date(p.opened_at).toISOString(), remainingRaw: p.remaining_raw, qtySource: p.qty_source, entryPriceSol: entry, priceSol: price, multiple: entry && price ? price / entry : null, valueSol: value, venue: m?.venue ?? null, progress: m?.progress ?? null, exitOrdersFailed: p.exit_orders_failed });
      }
    }
    const det = this.d.detector.stats;
    const recent = this.d.ledger.recentLaunches(10).map((r) => ({ mint: r.mint, symbol: r.symbol, mode: r.launch_mode, firstSource: r.first_source, apiLatencyMs: r.api_latency_ms, chainLatencyMs: r.chain_latency_ms, decision: r.decision, reason: r.reason }));
    return redactDeep({
      at: new Date(now).toISOString(),
      mode: this.d.cfg.mode,
      wallet: this.d.cfg.wallet,
      strategy: this.d.strategy.name,
      paused: this.paused(),
      stopping: this.stopRequested,
      cycles: this.cycles,
      lastCycleMs: this.lastCycleMs,
      equity: { spentSol: Number(spent) / 1e9, proceedsSol: Number(proceeds) / 1e9, networkFeesSol: Number(fees) / 1e9, rentSol: Number(rent) / 1e9, openValueSol: openValue, pnlSol: (Number(proceeds) - Number(spent) - Number(fees) - Number(rent)) / 1e9 + openValue },
      caps: { open: this.openCount(), maxOpen: this.d.cfg.buy.maxOpen, lifetimeSolUsed: Number(this.d.ledger.lifetimeBuyLamports(dry)) / 1e9, lifetimeSol: this.d.cfg.buy.lifetimeSol },
      queue: this.d.ledger.queueHealth(now, dry),
      alertsSent: this.d.alerter.sent,
      detection: { ...det, pending: [...this.pending.values()].map((p) => ({ mint: p.launch.mint, waiting: p.lastReason, ...(p.lastReason === NO_CANDLE_MARKET && p.marketWhy ? { market: p.marketWhy } : {}) })), recent },
      positions: open,
      stats: this.stats,
    });
  }

  writeStatus(): void {
    try {
      const path = join(this.d.cfg.stateDir, "status.json");
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.statusObject(), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      renameSync(tmp, path);
    } catch (e) {
      this.d.log.warn("status_write_failed", { error: String((e as Error).message) });
    }
  }
}

/** One process per state dir. */
export function acquireLock(stateDir: string): { release(): void } | null {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release() {
          try {
            unlinkSync(path);
          } catch {
            /* gone */
          }
        },
      };
    } catch {
      const pid = Number(readControl(path) ?? "0");
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as any)?.code === "EPERM";
        }
      }
      if (alive) return null;
      try {
        unlinkSync(path); // stale lock from a crashed run
      } catch {
        /* raced */
      }
    }
  }
  return null;
}

export function lockHeld(stateDir: string): boolean {
  return existsSync(join(stateDir, "lock"));
}
