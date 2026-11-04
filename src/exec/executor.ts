/**
 * The order executor. Every order is one row with its own attempt clock; each sweep claims due orders in one
 * statement and runs at most one attempt each. Nothing in an attempt sleeps: a read that is not ready yet
 * reschedules the order, so exits and STOP stay responsive.
 *
 * Rules:
 *  - quantity and proceeds are booked from the transaction's balance deltas, never the quote
 *  - attempts are capped, backoff is jittered and scheduled per order (next_attempt_at), and a throw costs an
 *    attempt exactly like a failure
 *  - the terminal state is sticky one layer up: a position whose exit orders keep failing goes `exit_stuck`
 *  - errors branch on `.code` / `.status` / `.stage` / `.reason`, never on message text; logs are stored in full
 *  - a refusal is definite only when Candle says so for a step that broadcasts nothing (build/sign, 4xx, not
 *    retryable); transport failures (fetch failed, ECONNRESET, timeouts, 5xx) are always retried
 *  - the signature is persisted BEFORE submit; before any rebuild the persisted signature is checked on chain and
 *    its blockhash must be expired by block height (isBlockhashValid false), so no two transactions of one order
 *    can ever be live at once
 */
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Ledger, OrderRow, PositionRow, QtySource } from "../ledger.ts";
import type { Alerter } from "../alerts.ts";
import { errorJson } from "../redact.ts";
import { blockhashValid, getTransaction, signatureStatus, tokenAccounts, tokenBalance, type Rpc } from "../solana/rpc.ts";
import { candleCurve, WSOL } from "../solana/pda.ts";
import { buyImpact, decodeCandleCurve } from "../market/curve.ts";
import { fillFromTx, type Fill } from "./fills.ts";
import { blockhashOfSigned, signatureOfSigned, type TradeRail } from "./trader.ts";

/** Lease while an attempt runs: longer than every timeout inside one attempt put together. */
export const LEASE_MS = 180_000;
/** Failed reads of a landed transaction before the bot books from Candle's numbers instead (and alerts). */
export const TX_READ_CAP = 6;
/** Never judge a signature dead sooner than this after signing, whatever the chain says (clock skew, RPC lag). */
export const SIGNATURE_MIN_AGE_MS = 20_000;
/** Re-scans of the wallet for an ending buy's tokens that are there but not yet explained (RPC lag), on the backoff. */
export const ADOPT_SCAN_CAP = 10;
/** Pages of token-account history read per scan (100 signatures each), stopping at the order's creation. */
export const ADOPT_PAGES = 10;

/** An ending buy scans at least this long (the balance and history may lag a trade that just landed). */
export const ENDING_MIN_MS = 120_000;
/** A transaction of an attempt can land up to this long after the attempt's call ended (its blockhash life, with margin). */
export const ATTEMPT_LAND_SEC = 150;

type Ending = { status: "failed" | "rejected"; code: string; detail?: string; at?: number };

export interface DryPricer {
  /** Tokens out (raw) for spending `lamports` on the coin now. */
  buyOut(mint: string, lamports: bigint): Promise<bigint>;
  /** Lamports out for selling `raw` tokens now. */
  sellOut(mint: string, raw: bigint, decimals: number): Promise<bigint>;
}

export interface ExecutorDeps {
  cfg: Config;
  ledger: Ledger;
  rail: TradeRail | null;
  /** The TEE wallet's linked-wallet id (the build's payer). */
  linkedWalletId?: string;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  dry?: DryPricer;
  now?: () => number;
  random?: () => number;
  /** PAUSE_BUYS: a queued buy is not built while this says true. */
  buysPaused?: () => boolean;
}

type Outcome =
  | { kind: "filled"; fill: Fill | null; result?: any; source: QtySource }
  | { kind: "reverted"; fill: Fill | null }
  | { kind: "rejected"; code: string; detail: string }
  | { kind: "retry"; code: string; detail: string; afterMs?: number }
  | { kind: "wait"; untilMs: number; why: string };

export interface ErrorInfo {
  code: string;
  /** True when the error is Candle's own structured refusal (CandleApiError: string code + HTTP status). */
  candle: boolean;
  status?: number;
  retryable: boolean;
  stage?: string;
  reason?: string;
  signature?: string;
  recorded?: boolean;
  retryAfter?: number;
  logs?: string[];
}

function logsOf(x: any): string[] | undefined {
  for (const c of [x?.data?.logs, x?.logs, x?.data?.err?.logs, x?.discovery?.logs, x?.coverage?.logs]) if (Array.isArray(c)) return c.map(String);
  return undefined;
}

/** Transport-level codes (Node fetch/undici, sockets, DNS): the request may or may not have arrived. */
const TRANSPORT = /^(E[A-Z]+|UND_ERR_[A-Z_]+|ABORT_ERR|ERR_[A-Z_]+)$/;

/** Read an error's structure. Only a CandleApiError can be a definite refusal; everything else is retryable. */
export function errorInfo(e: unknown): ErrorInfo {
  const x = e as any;
  if (x && typeof x.code === "string" && typeof x.status === "number") {
    // Timeouts and rate limits are never refusals, whatever the envelope says (a bare proxy 429 has no envelope at all).
    const busy = x.status >= 500 || x.status === 408 || x.status === 425 || x.status === 429;
    return { code: x.code, candle: true, status: x.status, retryable: !!x.retryable || busy, stage: x.stage, reason: x.reason, signature: x.signature, recorded: x.recorded, retryAfter: x.retryAfter, logs: logsOf(x) };
  }
  if (x?.name === "TimeoutError" || x?.name === "AbortError") return { code: "TIMEOUT", candle: false, retryable: true };
  if (x && typeof x.code === "string" && TRANSPORT.test(x.code)) return { code: `NET_${x.code}`, candle: false, retryable: true };
  if (x && typeof x.code === "number") return { code: `RPC_${x.code}`, candle: false, retryable: true, logs: logsOf(x) };
  if (x?.cause) {
    const c = errorInfo(x.cause);
    return { ...c, logs: c.logs ?? logsOf(x) };
  }
  return { code: typeof x?.code === "string" ? `X_${x.code}` : "UNKNOWN", candle: false, retryable: true, logs: logsOf(x) };
}

export class Executor {
  private d: ExecutorDeps;
  private now: () => number;
  private random: () => number;

  constructor(d: ExecutorDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  backoffMs(attempts: number): number {
    const { baseDelayMs, maxDelayMs } = this.d.cfg.retry;
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(exp * (0.5 + this.random() * 0.5));
  }

  /**
   * Run one attempt for each due order, sells first, claiming ONE order at a time (so no claimed order waits behind
   * others while its lease runs), until `limit` orders, the time budget, or a stop request. Never throws.
   */
  async sweep(limit = 5, opts: { onlyIds?: number[]; side?: "buy" | "sell"; reconcileOnly?: boolean; budgetMs?: number; shouldStop?: () => boolean } = {}): Promise<void> {
    const start = this.now();
    const budget = opts.budgetMs ?? LEASE_MS / 3;
    const ran: number[] = [];
    for (let i = 0; i < limit; i++) {
      if (opts.shouldStop?.() || this.now() - start > budget) return;
      // Without a trade rail (dry), live orders are never claimed: they wait for a live process. An order runs at
      // most once per sweep (a settle-only hand-back stays due for the build step, but is not re-claimed here).
      const due = this.d.ledger.claimDue(this.now(), LEASE_MS, 1, { dryOnly: !this.d.rail, onlyIds: opts.onlyIds, excludeIds: ran, side: opts.side, reconcileOnly: opts.reconcileOnly });
      if (!due.length) return;
      ran.push(due[0].id);
      await this.runOne(due[0], !!opts.reconcileOnly);
    }
  }

  private async runOne(o: OrderRow, reconcileOnly = false): Promise<void> {
    {
      try {
        await this.attempt(o, reconcileOnly);
        return;
      } catch (e) {
        // Last-resort guard: count the attempt and reschedule. Never terminal while a signature may still land.
        const ord = this.d.ledger.order(o.id)!;
        const attempts = ord.attempts + (ord.attempts === o.attempts ? 1 : 0);
        this.d.ledger.updateOrder(o.id, { attempts, status: "pending", next_attempt_at: this.now() + this.backoffMs(attempts), lease_until: 0, last_error_code: "INTERNAL", last_error: errorJson(e), updated_at: this.now() });
        this.d.log.error("order_internal_error", { order: o.id, error: errorJson(e) });
        const k = (ord.internal_errors ?? 0) + 1;
        this.d.ledger.updateOrder(o.id, { internal_errors: k });
        this.alert(`order:${o.id}:internal_error:${k >= 20 ? "20+" : k >= 5 ? "5+" : "1"}`, `order ${o.id} ${ord.side}: ${k} internal errors (last ${String((e as Error)?.message ?? e).slice(0, 200)})`);
        // Never ended here while something may be live: a signature, a conflict, an ending buy, or a main-payer build.
        const maybeLive = !!ord.signature || ord.last_error_code === "IDEMPOTENCY_CONFLICT" || !!ord.ending || (this.d.rail?.payer?.type === "main" && ord.ever_signed === 1);
        if (attempts >= ord.max_attempts && !maybeLive) this.terminal(this.d.ledger.order(o.id)!, "failed", "INTERNAL");
      }
    }
  }

  private async attempt(o: OrderRow, reconcileOnly = false): Promise<void> {
    const pos = this.d.ledger.position(o.position_id)!;
    if (pos.dry) return this.dryAttempt(o, pos);
    if (!this.d.rail) {
      // Never reached (claims skip live orders without a rail); if it is, hand the order back untouched.
      this.d.ledger.updateOrder(o.id, { status: "pending", lease_until: 0 });
      return;
    }

    const main = this.d.rail.payer?.type === "main";
    // 1. An earlier attempt signed something: settle it on chain before anything else.
    if (o.signature) {
      const r = await this.reconcileSignature(o, pos);
      if (r) return this.apply(o, pos, r);
    }

    // 2. The order has history: ask Candle's ledger what it knows before building again, or deciding anything.
    let job: any = null;
    if (o.attempts > 0 || o.ever_signed === 1) {
      try {
        job = await this.d.rail.job(o.client_trade_id);
      } catch (e) {
        return this.apply(o, pos, this.readFailed(o, pos, errorInfo(e).code, "job read failed"), e);
      }
      if (o.read_failures) this.d.ledger.updateOrder(o.id, { read_failures: 0 });
      if (job?.status === "confirmed" && job.signature) {
        // Candle says it landed. Book it from its transaction, read again until the RPC serves it; never clear it.
        this.d.ledger.updateOrder(o.id, { signature: job.signature, signed_at: o.signed_at ?? this.now(), ever_signed: 1, candle_confirmed: 1 });
        return this.apply(o, pos, await this.landed(this.d.ledger.order(o.id)!, pos, job.signature, null));
      }
      if (job?.status === "failed" && job.errorCode === "TRADE_REVERTED") return this.apply(o, pos, await this.revertedOutcome(pos, job.signature ?? null));
      // IDEMPOTENCY_CONFLICT for this id, or payer main with a build that may be executing: Candle's job decides.
      // While it is built (or confirmed without a signature yet), nothing is rebuilt and nothing ends the order:
      // no deadline, no PAUSE_BUYS, no impact recheck, no attempt cap.
      const unsettled = job && job.status !== "failed";
      if (unsettled && (o.last_error_code === "IDEMPOTENCY_CONFLICT" || (main && o.ever_signed === 1))) {
        // A main job stuck at built: once, after builtProbeMs, a same-id build asks Candle for its signature (a
        // replay of a landed id returns it; one still in flight answers IDEMPOTENCY_CONFLICT). Never a new trade.
        if (main && job.status === "built") {
          const seen = o.built_seen_at ?? this.now();
          if (o.built_seen_at === null) this.d.ledger.updateOrder(o.id, { built_seen_at: seen });
          // A same-id build of a buy can execute it anew if the old job died: only while the buy itself would still
          // be placed (before its deadline, buys not paused, the impact recheck passing).
          if (!o.probed && this.now() - seen >= this.d.cfg.retry.builtProbeMs && !reconcileOnly && !o.ending && (await this.buyStillGood(o, pos))) {
            this.d.ledger.updateOrder(o.id, { probed: 1 });
            return this.probe(o, pos);
          }
        }
        // A stale buy whose job stays built past builtHoldMs: Candle never sent it (its blockhash is long dead). End it
        // after the wallet/tx scan, so it stops holding a slot and the lifetime cap. Alerted.
        if (main && o.side === "buy" && job.status === "built" && o.built_seen_at !== null) {
          const stale = o.deadline_at !== null && this.now() > o.deadline_at;
          if (o.ending || (stale && this.now() - o.built_seen_at >= this.d.cfg.retry.builtHoldMs)) {
            if (!o.ending) this.alert(`order:${o.id}:built_held`, `order ${o.id} buy ${pos.mint}: Candle's job stayed built ${Math.round((this.now() - o.built_seen_at) / 3_600_000 * 10) / 10} h past the buy's deadline; ending it after a wallet scan`);
            return this.endBuy(o, pos, { status: "failed", code: "BUILT_HELD" });
          }
        }
        const n = o.read_failures + 1;
        this.d.ledger.updateOrder(o.id, { read_failures: n });
        this.alert(`order:${o.id}:job_unsettled:${n >= 20 ? "20+" : n >= 5 ? "5+" : "1"}`, `order ${o.id} ${o.side} ${pos.mint}: Candle's job is ${job.status}; waiting for it to settle`);
        return this.apply(o, pos, { kind: "wait", untilMs: this.now() + this.backoffMs(Math.min(n, 30)), why: `job ${job.status}` });
      }
      if (o.last_error_code === "IDEMPOTENCY_CONFLICT") {
        this.d.ledger.updateOrder(o.id, { last_error_code: null });
        o = { ...o, last_error_code: null };
      }
    }

    // A buy that is already ending (its tokens not yet explained): only the wallet/tx scan runs, never a new build.
    if (o.side === "buy" && o.ending) return this.endBuy(o, pos, JSON.parse(o.ending) as Ending);

    // Payer main and a build that may have executed, with a job that says failed (not a revert): the SDK's word is
    // that it may still be on chain. Before ending such an order, the wallet must not hold tokens we can't account for.
    const failedMain = main && o.ever_signed === 1 && o.attempts > 0 && (job === null || job?.status === "failed");
    const stopBuy = async (code: string, detail: string) => {
      if (failedMain && o.side === "buy") return this.endBuy(o, pos, { status: "rejected", code, detail });
      return this.terminal(o, "rejected", code, detail);
    };

    // 3. Out of attempts: terminal. (Checked after reconciliation, so a landed trade is never marked failed.)
    const pastDeadline = o.side === "buy" && o.deadline_at !== null && this.now() > o.deadline_at;
    let finalCheck = false;
    if (o.attempts >= o.max_attempts) {
      // A failed main job at the cap: one same-id build is the check (Candle replays a landed id, or answers
      // IDEMPOTENCY_CONFLICT for one in flight). Never for a stale buy, where a rebuild could buy anew.
      if (failedMain && job?.status === "failed" && !o.final_check && (await this.buyStillGood(o, pos))) {
        // The check is a build: a settle-only sweep hands the order back without using it up.
        if (reconcileOnly) {
          this.d.ledger.updateOrder(o.id, { status: "pending", lease_until: 0 });
          return;
        }
        this.d.ledger.updateOrder(o.id, { final_check: 1 });
        finalCheck = true;
      } else {
        if (failedMain && o.side === "buy") return this.endBuy(o, pos, { status: "failed", code: o.last_error_code ?? "MAX_ATTEMPTS" });
        return this.terminal(o, "failed", o.last_error_code ?? "MAX_ATTEMPTS");
      }
    }
    // Everything that could be live under this order was settled above, so a stale, paused or chasing buy stops here.
    if (o.side === "buy" && !finalCheck) {
      if (pastDeadline) return stopBuy("DEADLINE", "the entry decision is stale");
      if (this.d.buysPaused?.()) return stopBuy("PAUSE_BUYS", "buys paused before this attempt");
      if (o.attempts > 0) {
        const stop = await this.recheckBuy(o, pos);
        if (stop) return stop.kind === "rejected" ? stopBuy(stop.code, stop.detail) : this.apply(o, pos, stop);
      }
    }

    // A settle-only sweep (outside the cycle budget) never starts a new build: hand the order back as it was.
    if (reconcileOnly) {
      this.d.ledger.updateOrder(o.id, { status: "pending", lease_until: 0 });
      return;
    }

    // 4. A fresh attempt. Count it first: a throw anywhere below has already cost it.
    const n = o.attempts + 1;
    // Payer main executes inside the build: mark it possibly spent BEFORE the call, so a crash mid-build cannot
    // leave an order that the caps and the reconciliation think never ran.
    this.d.ledger.updateOrder(o.id, { attempts: n, updated_at: this.now(), ...(main ? { ever_signed: 1 } : {}) });
    const att = this.d.ledger.startAttempt(o.id, n, this.now());
    const cfg = this.d.cfg;
    const prio = o.side === "buy" ? cfg.buy.maxPriorityFeeLamports : cfg.sell.maxPriorityFeeLamports;
    let phase: "build" | "sign" | "submit" = "build";
    try {
      const built = await this.d.rail.build({
        clientTradeId: o.client_trade_id,
        mint: pos.mint,
        side: o.side,
        amountRaw: o.amount_raw,
        payer: this.d.rail.payer ?? { type: "linked", linkedWalletId: this.d.linkedWalletId ?? "" },
        maxSlippageBps: o.slippage_bps,
        ...(prio !== undefined ? { maxPriorityFeeLamports: prio } : {}),
      });
      if (built.status === "executed") {
        // Payer main: Candle signed and sent it inside this call. Linked: an idempotent replay of a landed id.
        this.d.ledger.updateOrder(o.id, { signature: built.signature, signed_at: o.signed_at ?? this.now(), ever_signed: 1, fee_bps: Number(built.fee?.bps ?? 0), min_out_raw: String(built.amounts?.minOutRaw ?? "") });
        const r = await this.landed(this.d.ledger.order(o.id)!, pos, built.signature, built);
        this.d.ledger.endAttempt(att, this.now(), "replay", null, null);
        return this.apply(o, pos, r);
      }
      this.d.ledger.updateOrder(o.id, { ...(built.expectedOutRaw ? { expected_out_raw: String(built.expectedOutRaw) } : {}), min_out_raw: String(built.minOutRaw ?? ""), fee_bps: Number(built.fee?.bps ?? 0) });
      if (this.d.rail.payer?.type === "main") {
        // A main-payer build executes inline; an unsigned "built" answer spent nothing and is not ours to sign.
        this.d.ledger.endAttempt(att, this.now(), "rejected", "MAIN_NOT_EXECUTED", null);
        return this.apply(o, pos, { kind: "rejected", code: "MAIN_NOT_EXECUTED", detail: "payer main answered built" });
      }
      if (built.chain !== "solana") throw Object.assign(new Error("built for another chain"), { code: "WRONG_CHAIN", status: 400 });
      if (built.walletAddress !== cfg.wallet) {
        this.d.ledger.endAttempt(att, this.now(), "rejected", "WRONG_WALLET", JSON.stringify({ walletAddress: built.walletAddress }));
        return this.apply(o, pos, { kind: "rejected", code: "WRONG_WALLET", detail: `build names ${built.walletAddress}` });
      }
      phase = "sign";
      const signed = await this.d.rail.sign(built.artifacts.transactionBase64);
      const sig = signatureOfSigned(signed);
      this.d.ledger.updateOrder(o.id, { signature: sig, signed_at: this.now(), blockhash: blockhashOfSigned(signed), ever_signed: 1, updated_at: this.now() });
      phase = "submit";
      const res = await this.d.rail.submit(o.client_trade_id, signed);
      const r = await this.landed(this.d.ledger.order(o.id)!, pos, res.signature ?? sig, res);
      this.d.ledger.endAttempt(att, this.now(), r.kind, null, null);
      return this.apply(o, pos, r);
    } catch (e) {
      const info = errorInfo(e);
      const ej = errorJson(e);
      this.d.ledger.endAttempt(att, this.now(), "error:" + phase, info.code, ej);
      this.d.ledger.updateOrder(o.id, { last_error_code: info.code, last_error: ej, updated_at: this.now() });
      this.d.log.warn("order_attempt_error", { order: o.id, side: o.side, mint: pos.mint, attempt: n, phase, code: info.code, status: info.status, stage: info.stage, reason: info.reason, logs: info.logs });
      const fresh = this.d.ledger.order(o.id)!;
      return this.apply(fresh, pos, await this.classify(fresh, pos, info, phase, n), e);
    }
  }

  /** Would this order still be placed now? Sells always; a buy only before its deadline, unpaused, impact passing. */
  private async buyStillGood(o: OrderRow, pos: PositionRow): Promise<boolean> {
    if (o.side !== "buy") return true;
    if (o.deadline_at !== null && this.now() > o.deadline_at) return false;
    if (this.d.buysPaused?.()) return false;
    return (await this.recheckBuy(o, pos)) === null;
  }

  /** End a buy that may have executed: book our tx or adopt its tokens if found, re-scan while unexplained, else end. */
  private async endBuy(o: OrderRow, pos: PositionRow, end: Ending): Promise<void> {
    const r = await this.unexplainedTokens(o, pos, end);
    if (r) return this.apply(o, pos, r);
    return this.terminal(this.d.ledger.order(o.id)!, end.status, end.code, end.detail);
  }

  /** The one same-id probe of a long-built main job: only its answer is used (a signature to reconcile, or a wait). */
  private async probe(o: OrderRow, pos: PositionRow): Promise<void> {
    const prio = o.side === "buy" ? this.d.cfg.buy.maxPriorityFeeLamports : this.d.cfg.sell.maxPriorityFeeLamports;
    const att = this.d.ledger.startAttempt(o.id, o.attempts, this.now());
    try {
      const r: any = await this.d.rail!.build({ clientTradeId: o.client_trade_id, mint: pos.mint, side: o.side, amountRaw: o.amount_raw, payer: this.d.rail!.payer, maxSlippageBps: o.slippage_bps, ...(prio !== undefined ? { maxPriorityFeeLamports: prio } : {}) });
      this.d.ledger.endAttempt(att, this.now(), "probe:" + String(r?.status ?? "?"), null, null);
      if (r?.status === "executed" && r.signature) {
        this.d.ledger.updateOrder(o.id, { signature: r.signature, signed_at: o.signed_at ?? this.now() });
        return this.apply(o, pos, await this.landed(this.d.ledger.order(o.id)!, pos, r.signature, r));
      }
    } catch (e) {
      const info = errorInfo(e);
      this.d.ledger.endAttempt(att, this.now(), "probe:error", info.code, errorJson(e));
      if (info.signature) this.d.ledger.updateOrder(o.id, { signature: info.signature, signed_at: o.signed_at ?? this.now() });
      this.d.log.info("built_probe", { order: o.id, code: info.code, stage: info.stage, signature: info.signature ?? null });
    }
    this.alert(`order:${o.id}:built_probe`, `order ${o.id} ${o.side} ${pos.mint}: Candle's job stayed built; probed once under the same id`);
    return this.apply(o, pos, { kind: "wait", untilMs: this.now() + 30_000, why: "probed a long-built job" });
  }

  /** Before rebuilding a buy, the market must still be the one the filter approved (no chasing a pump). */
  private async recheckBuy(o: OrderRow, pos: PositionRow): Promise<Outcome | null> {
    let v: any;
    try {
      v = (await this.d.rpc.call<any>("getAccountInfo", [candleCurve(pos.mint), { encoding: "base64", commitment: "confirmed" }]))?.value;
    } catch (e) {
      return this.readFailed(o, pos, errorInfo(e).code, "curve read failed");
    }
    try {
      const c = decodeCandleCurve(v);
      if (c.quoteMint !== WSOL) return { kind: "rejected", code: "QUOTE_MINT", detail: "curve is not SOL-quoted" };
      const bps = buyImpact(c, BigInt(o.amount_raw)).impactBps;
      if (bps > this.d.cfg.filters.maxImpactBps) return { kind: "rejected", code: "IMPACT", detail: `impact ${bps} bps on retry` };
      return null;
    } catch (e) {
      return { kind: "rejected", code: "CURVE", detail: String((e as Error).message) };
    }
  }

  private async classify(o: OrderRow, pos: PositionRow, info: ErrorInfo, phase: "build" | "sign" | "submit", n: number): Promise<Outcome> {
    const back = this.backoffMs(n);
    if (info.stage === "executed" || info.reason === "prior_attempt_on_chain") {
      const sig = info.signature ?? o.signature;
      if (sig) {
        this.d.ledger.updateOrder(o.id, { signature: sig, signed_at: o.signed_at ?? this.now(), ever_signed: 1 });
        return this.landed(this.d.ledger.order(o.id)!, pos, sig, null);
      }
      // On chain per Candle but no signature in hand: Candle's job record has it; read it next sweep.
      return { kind: "wait", untilMs: this.now() + 5_000, why: "landed per Candle; reading its job" };
    }
    if (info.stage === "reverted" || info.code === "TRADE_REVERTED") return this.revertedOutcome(pos, info.signature ?? o.signature);
    if (info.code === "IDEMPOTENCY_CONFLICT") {
      // Something was built or signed under this id and may be on chain (unconfirmed, in flight, unprovable):
      // never fail it, never rebuild over it. Reconcile the signature and Candle's job until it settles.
      if (info.signature && !o.signature) this.d.ledger.updateOrder(o.id, { signature: info.signature, signed_at: this.now(), ever_signed: 1 });
      const after = info.retryAfter ? Math.max(0, info.retryAfter - this.now()) : 0;
      return { kind: "wait", untilMs: this.now() + Math.max(back, after, 10_000), why: `idempotency conflict (${info.stage ?? info.reason ?? "?"})` };
    }
    if (info.code === "RATE_LIMITED" || info.code === "DAILY_CAP_REACHED") {
      const after = info.retryAfter ? Math.max(0, info.retryAfter - this.now()) : back;
      return { kind: "retry", code: info.code, detail: "rate limited", afterMs: Math.max(after, back) };
    }
    if (this.d.rail?.payer?.type === "main" && phase === "build") {
      // Payer main executes inside build, so a failed build may have spent. Candle's own non-retryable 4xx (no stage)
      // is a refusal before execution. Anything else may have executed: mark it possibly spent; the next attempt reads
      // Candle's job first, and a same-id rebuild is Candle's replay of that trade, never a second one.
      // A refusal only when it names nothing that ran: no signature, no stage, nothing recorded.
      if (info.candle && !info.retryable && (info.status ?? 0) >= 400 && (info.status ?? 0) < 500 && !info.signature && !info.stage && info.recorded === undefined) {
        // Proven unspent only when this was the first attempt (no earlier build could have run).
        if (n === 1) {
          this.d.ledger.updateOrder(o.id, { ever_signed: 0 });
          return { kind: "rejected", code: info.code, detail: "build refused" };
        }
        // An earlier attempt may have executed: the same wallet/tx check as any ending buy; stays counted.
        const detail = "build refused after an earlier attempt that may have run";
        if (o.side === "buy") {
          const adopt = await this.unexplainedTokens(o, pos, { status: "rejected", code: info.code, detail });
          if (adopt) return adopt;
        }
        return { kind: "rejected", code: info.code, detail };
      }
      if (info.signature) {
        this.d.ledger.updateOrder(o.id, { signature: info.signature, signed_at: this.now() });
        return { kind: "wait", untilMs: this.now() + 5_000, why: "main-payer error names a signature; reconciling" };
      }
      return { kind: "retry", code: info.code, detail: "main-payer build failed; reconciling", afterMs: back };
    }
    if (phase === "build" || phase === "sign") {
      // Nothing of this attempt is on the wire. Only Candle's own non-retryable 4xx is a definite refusal.
      if (info.candle && !info.retryable && (info.status ?? 0) >= 400 && (info.status ?? 0) < 500) return { kind: "rejected", code: info.code, detail: `${phase} refused` };
      return { kind: "retry", code: info.code, detail: `${phase} failed`, afterMs: back };
    }
    // submit: the transaction may have been broadcast (Candle's submit does not say whether its preflight ran).
    // Wait, then reconcile the signature on chain and by blockhash expiry before any rebuild.
    return { kind: "wait", untilMs: this.now() + Math.max(back, 10_000), why: `submit error ${info.code}` };
  }

  private async revertedOutcome(pos: PositionRow, sig: string | null): Promise<Outcome> {
    // Book the fee the revert cost from its transaction when it can be read.
    if (!sig) return { kind: "reverted", fill: null };
    const fill = await getTransaction(this.d.rpc, sig).then((tx) => (tx ? fillFromTx(tx, this.d.cfg.wallet, pos.mint) : null)).catch(() => null);
    return { kind: "reverted", fill };
  }

  /**
   * A possibly executed buy about to end: find what it did to the wallet before ending it. In order:
   *  1. our transaction(s) in the token account's history since the order was made (buys of about the ticket that no
   *     order has booked): booked from the transaction; two or more (a double execution) are all booked, alerted
   *  2. tokens received since the order in unbooked transactions, up to a loose cap on the order's expected fill
   *  3. tokens in the wallet that nothing explains yet: the history or a transaction may lag behind the balance, so
   *     the order stays pending and the scan repeats on the backoff (bounded by ADOPT_SCAN_CAP, alerted)
   * Returns null when the order can end with nothing adopted. From the first call on the order is `ending`: later
   * attempts only scan, never build.
   */
  private async unexplainedTokens(o: OrderRow, pos: PositionRow, end: Ending): Promise<Outcome | null> {
    const cur = this.d.ledger.order(o.id)?.ending;
    const endingAt = cur ? Number((JSON.parse(cur) as Ending).at ?? 0) : this.now();
    if (!cur) this.d.ledger.updateOrder(o.id, { ending: JSON.stringify({ ...end, at: endingAt }) });
    const scan = await this.scanSince(o, pos);
    if ("kind" in scan) return scan;
    const { found, gained, incomplete } = scan;
    if (found.length === 1) {
      this.d.ledger.updateOrder(o.id, { signature: found[0].signature, signed_at: o.signed_at ?? this.now() });
      this.alert(`order:${o.id}:found_tx`, `order ${o.id} buy ${pos.mint}: Candle's job is not confirmed, but its transaction ${found[0].signature} is on chain; booked from it`);
      return { kind: "filled", fill: found[0], result: null, source: "onchain" };
    }
    if (found.length > 1) {
      // Two or more of our buys under one order: book them all, so exits manage every token. Alerted.
      const sum = (k: "tokenDeltaRaw" | "solDeltaLamports" | "networkFeeLamports" | "rentLamports" | "swapLamports") => found.reduce((t, f) => t + f[k], 0n);
      const fill: Fill = { ...found[0], tokenDeltaRaw: sum("tokenDeltaRaw"), solDeltaLamports: sum("solDeltaLamports"), networkFeeLamports: sum("networkFeeLamports"), rentLamports: sum("rentLamports"), swapLamports: sum("swapLamports") };
      const sigs = found.map((f) => f.signature);
      this.d.ledger.updateOrder(o.id, { signature: sigs[0], signed_at: o.signed_at ?? this.now(), extra_signatures: JSON.stringify(sigs.slice(1)) });
      this.alert(`order:${o.id}:double_execution`, `order ${o.id} buy ${pos.mint}: ${sigs.length} transactions of ours landed under one order (${sigs.join(", ")}); all booked`);
      return { kind: "filled", fill, result: { signatures: sigs }, source: "onchain" };
    }
    // No transaction of ours: unexplained tokens received since the order, up to a loose cap on what this order could
    // have received (its expected fill plus slippage, x1.5 for a better fill than at decision time), are adopted.
    const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, pos.mint);
    if (bal === null) return this.readFailed(o, pos, "BALANCE_UNREADABLE", "wallet balance unreadable before ending a possibly executed buy");
    const others = this.d.ledger.positionsByStatus("opening", "open", "exit_stuck").filter((p) => p.mint === pos.mint && p.id !== pos.id && !!p.dry === !!pos.dry).reduce((s, p) => s + BigInt(p.remaining_raw), 0n);
    const free = bal - others;
    // Only what arrived after the order was made can be its fill: a bag already there is someone else's.
    const extra = free < gained ? free : gained;
    if (extra <= 0n) {
      // Nothing to adopt. Scan again (bounded) when tokens are there that nothing explains (the history or the
      // transaction may lag the balance), when the history could not be fully read, or while the ending is young
      // (the balance itself may lag a trade that just landed).
      const young = this.now() - endingAt < ENDING_MIN_MS;
      if (free <= 0n && !incomplete && !young) return null;
      const n = (this.d.ledger.order(o.id)?.adopt_scans ?? 0) + 1;
      if (n <= ADOPT_SCAN_CAP) {
        this.d.ledger.updateOrder(o.id, { adopt_scans: n });
        if (free > 0n || incomplete) this.alert(`order:${o.id}:rescan`, `order ${o.id} buy ${pos.mint}: ${free > 0n ? `the wallet holds ${free} tokens of this coin no position explains` : "the token account history is incomplete"}; scanning again before ending the order`);
        return { kind: "wait", untilMs: this.now() + this.backoffMs(n), why: `unexplained tokens, re-scan ${n}/${ADOPT_SCAN_CAP}` };
      }
      if (free > 0n || incomplete) this.alert(`order:${o.id}:unexplained_tokens`, `order ${o.id} buy ${pos.mint}: ${free > 0n ? `the wallet holds ${free} tokens of this coin no position explains` : "the history stayed incomplete"}, none found received since the order after ${ADOPT_SCAN_CAP} scans; not adopted (\`sell\` reaches them)`);
      return null;
    }
    const cap = this.adoptCap(o);
    if (cap === null || extra > cap) {
      this.alert(`order:${o.id}:unexplained_tokens`, `order ${o.id} buy ${pos.mint}: the wallet holds ${extra} unexplained tokens received since the order (cap ${cap ?? "unknown"}); not adopted (\`sell\` reaches them)`);
      return null;
    }
    this.alert(`order:${o.id}:adopted`, `order ${o.id} buy ${pos.mint}: Candle's job is not confirmed and no transaction was found; adopted ${extra} unexplained tokens (within the order's cap ${cap})`);
    return { kind: "filled", fill: null, result: { fallbackOut: extra.toString() }, source: "wallet" };
  }

  /**
   * The token account history since the order was made: `found` are our buys of this order (about the ticket's SOL,
   * landed inside one of the order's attempt windows, not booked by any order); `gained` is the net tokens received
   * since the order in unbooked transactions that spent SOL (a transfer-in is not a fill). Paged back to the order's
   * creation; `incomplete` when a transaction or its time could not be read. A read failure returns a wait outcome.
   */
  private async scanSince(o: OrderRow, pos: PositionRow): Promise<{ found: Fill[]; gained: bigint; incomplete: boolean } | Outcome> {
    const accts = await tokenAccounts(this.d.rpc, this.d.cfg.wallet, pos.mint);
    if (accts === null) return this.readFailed(o, pos, "BALANCE_UNREADABLE", "token accounts unreadable before ending a possibly executed buy");
    const booked = new Set(this.d.ledger.bookedSignatures());
    const since = Math.floor(o.created_at / 1000) - 60;
    const ticket = BigInt(o.amount_raw);
    // A build of ours can land from its start until its blockhash dies after the call returned (or timed out).
    const windows = this.d.ledger.attemptsFor(o.id).map((a) => [Math.floor(a.started_at / 1000) - 10, Math.ceil((a.ended_at ?? this.now()) / 1000) + ATTEMPT_LAND_SEC] as const);
    const inWindow = (bt: number) => windows.some(([a, b]) => bt >= a && bt <= b);
    const found: Fill[] = [];
    const seen = new Set<string>();
    let gained = 0n;
    let incomplete = false;
    for (const a of accts) {
      let before: string | undefined;
      let done = false;
      for (let page = 0; page < ADOPT_PAGES && !done; page++) {
        let sigs: any[] = [];
        try {
          sigs = (await this.d.rpc.call<any[]>("getSignaturesForAddress", [a, { limit: 100, commitment: "confirmed", ...(before ? { before } : {}) }])) ?? [];
        } catch (e) {
          return this.readFailed(o, pos, errorInfo(e).code, "token account history unreadable");
        }
        if (sigs.length < 100) done = true;
        for (const s of sigs) {
          if (!s?.signature) continue;
          before = s.signature;
          if (typeof s.blockTime === "number" && s.blockTime < since) {
            done = true;    // newest first: everything after this is older still
            break;
          }
          if (s.err || booked.has(s.signature) || seen.has(s.signature)) continue;
          seen.add(s.signature);
          const tx = await getTransaction(this.d.rpc, s.signature).catch(() => null);
          if (!tx) {
            incomplete = true;
            continue;
          }
          const bt = typeof tx.blockTime === "number" ? tx.blockTime : typeof s.blockTime === "number" ? s.blockTime : null;
          if (bt === null) {
            incomplete = true;   // no time to place it after the order: neither counted nor dropped for good
            continue;
          }
          if (bt < since) continue;
          let f: Fill;
          try {
            f = fillFromTx(tx, this.d.cfg.wallet, pos.mint);
          } catch {
            incomplete = true;   // an unreadable transaction (no meta): it may be ours
            continue;
          }
          if (f.err) continue;
          const spent = -f.swapLamports;
          if (f.tokenDeltaRaw > 0n && spent <= 0n) continue;   // received without paying: a transfer or airdrop
          gained += f.tokenDeltaRaw;
          if (f.tokenDeltaRaw > 0n && spent >= ticket && spent <= (ticket * 1_100n) / 1_000n && inWindow(bt)) found.push(f);
        }
      }
      if (!done) incomplete = true;
    }
    return { found, gained, incomplete };
  }

  /** The adoption cap: the order's expected fill plus slippage, x1.5 (a better fill than at decision time). */
  private adoptCap(o: OrderRow): bigint | null {
    const expected = o.expected_out_raw && /^\d+$/.test(o.expected_out_raw) ? BigInt(o.expected_out_raw) : null;
    return expected === null ? null : (expected * BigInt(10_000 + o.slippage_bps) * 3n) / 20_000n;
  }

  /**
   * For `sell` on a coin whose buy ended failed or rejected: how many wallet tokens that buy can claim. Our own
   * transaction(s) found in its attempt windows (their tokens, their cost), else tokens received since the order for SOL,
   * up to the adoption cap (cost the ticket). Never a bag that was already there or arrived by transfer.
   */
  async reopenable(orderId: number): Promise<{ amount: bigint; costLamports: bigint; signatures: string[] } | { why: string }> {
    const o = this.d.ledger.order(orderId);
    const pos = o && this.d.ledger.position(o.position_id);
    if (!o || !pos || o.side !== "buy") return { why: "no such buy" };
    const scan = await this.scanSince(o, pos);
    if ("kind" in scan) return { why: "token account history unreadable" };
    const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, pos.mint);
    if (bal === null) return { why: "wallet balance unreadable" };
    const others = this.d.ledger.positionsByStatus("opening", "open", "exit_stuck").filter((p) => p.mint === pos.mint && p.id !== pos.id && !!p.dry === !!pos.dry).reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
    const free = bal - others;
    const min = (a: bigint, b: bigint) => (a < b ? a : b);
    if (scan.found.length) {
      const tokens = scan.found.reduce((t, f) => t + f.tokenDeltaRaw, 0n);
      const cost = scan.found.reduce((t, f) => t - f.swapLamports, 0n);
      const amount = min(free, tokens);
      return amount > 0n ? { amount, costLamports: cost, signatures: scan.found.map((f) => f.signature) } : { why: "the wallet holds none unexplained" };
    }
    const cap = this.adoptCap(o);
    if (cap === null) return { why: "the order has no expected fill to cap a claim" };
    const amount = min(min(free, scan.gained), cap);
    if (amount <= 0n) return { why: free > 0n ? `the wallet's ${free} unexplained tokens were not received since the order` : "the wallet holds none unexplained" };
    const ticket = BigInt(o.amount_raw);
    return { amount, costLamports: ticket + (ticket * BigInt(o.fee_bps ?? 0)) / 10_000n, signatures: [] };
  }

  /** A status or job read failed: no attempt is spent; reads are counted, alerted in buckets and backed off. */
  private readFailed(o: OrderRow, pos: PositionRow, code: string, why: string): Outcome {
    const n = (this.d.ledger.order(o.id)?.read_failures ?? 0) + 1;
    this.d.ledger.updateOrder(o.id, { read_failures: n });
    const bucket = n >= 20 ? "20+" : n >= 5 ? "5+" : null;
    if (bucket) this.alert(`order:${o.id}:read_failures:${bucket}`, `order ${o.id} ${o.side} ${pos.mint}: ${n} failed reads (${why}, ${code})`);
    return { kind: "wait", untilMs: this.now() + this.backoffMs(Math.min(n, 30)), why };
  }

  /** The signature landed: read its transaction once and book from it; if unreadable, come back later. */
  private async landed(o: OrderRow, pos: PositionRow, signature: string, result: any): Promise<Outcome> {
    let tx: any = null;
    try {
      tx = await getTransaction(this.d.rpc, signature);
    } catch {
      tx = null;
    }
    if (tx) {
      const fill = fillFromTx(tx, this.d.cfg.wallet, pos.mint);
      if (fill.err) return { kind: "reverted", fill };
      return { kind: "filled", fill, result, source: "onchain" };
    }
    // It landed, so never conclude "nothing arrived". Read again later; after TX_READ_CAP failed reads book from
    // Candle's numbers: actualOutRaw (from this result, or by replaying confirm), else the build's minOutRaw. Alerted.
    const n = o.tx_read_failures + 1;
    this.d.ledger.updateOrder(o.id, { tx_read_failures: n });
    if (n < TX_READ_CAP) return { kind: "wait", untilMs: this.now() + this.backoffMs(n), why: `transaction ${signature} unreadable (${n})` };
    let actual = result?.amounts?.actualOutRaw;
    if (!(typeof actual === "string" && /^\d+$/.test(actual)) && this.d.rail) {
      try {
        actual = (await this.d.rail.confirm(o.client_trade_id, signature))?.amounts?.actualOutRaw;
      } catch {
        actual = undefined;
      }
    }
    const source: QtySource = typeof actual === "string" && /^\d+$/.test(actual) ? "server" : "minout";
    const out = source === "server" ? actual : result?.amounts?.minOutRaw ?? o.min_out_raw;
    if (typeof out !== "string" || !/^\d+$/.test(out) || BigInt(out) <= 0n) {
      this.alert(`order:${o.id}:qty_unknown`, `order ${o.id} landed (${signature}) but its fill cannot be read and Candle gave no amount`);
      return { kind: "wait", untilMs: this.now() + this.d.cfg.retry.maxDelayMs, why: "fill unknown" };
    }
    this.alert(`qty_fallback:${o.id}`, `order ${o.id} booked from ${source}: transaction ${signature} unreadable`);
    return { kind: "filled", fill: null, result: { fallbackOut: out, fee: result?.fee }, source };
  }

  /** Settle a persisted signature. Returns an outcome when it is decided, or null to go on building. */
  private async reconcileSignature(o: OrderRow, pos: PositionRow): Promise<Outcome | null> {
    let st;
    try {
      st = await signatureStatus(this.d.rpc, o.signature!);
    } catch (e) {
      return this.readFailed(o, pos, errorInfo(e).code, "status read failed");
    }
    if (o.read_failures) this.d.ledger.updateOrder(o.id, { read_failures: 0 });
    // Only confirmed or finalized counts as landed: a processed transaction can still drop.
    if (st.found && st.confirmationStatus === "processed") return { kind: "wait", untilMs: this.now() + 5_000, why: "processed, not yet confirmed" };
    if (st.found && !st.err) return this.landed(o, pos, o.signature!, null);
    if (st.found && st.err) return this.revertedOutcome(pos, o.signature);
    // Candle's job says this signature is confirmed: never clear it; read again until the RPC serves it.
    if (o.candle_confirmed === 1) return this.landed(o, pos, o.signature!, null);
    // Not on chain. It is dead only once its blockhash can no longer be used (judged by the chain's block height).
    if (this.now() - (o.signed_at ?? 0) < SIGNATURE_MIN_AGE_MS) return { kind: "wait", untilMs: (o.signed_at ?? this.now()) + SIGNATURE_MIN_AGE_MS, why: "signature may still land" };
    if (!o.blockhash) {
      // A signature learned from Candle (no transaction bytes here): wait the conservative maximum, then recheck.
      if (this.now() - (o.signed_at ?? 0) < 180_000) return { kind: "wait", untilMs: (o.signed_at ?? this.now()) + 180_000, why: "signature may still land" };
    } else {
      let valid: boolean;
      try {
        valid = await blockhashValid(this.d.rpc, o.blockhash);
      } catch (e) {
        return this.readFailed(o, pos, errorInfo(e).code, "blockhash check failed");
      }
      if (valid) return { kind: "wait", untilMs: this.now() + 10_000, why: "blockhash still valid" };
    }
    // Expired: one last status check (it could have landed in the final slots), then clear it so the rebuild under
    // the same clientTradeId is the only live transaction.
    try {
      const last = await signatureStatus(this.d.rpc, o.signature!);
      if (last.found) return { kind: "wait", untilMs: this.now() + 2_000, why: "landed at the last moment" };
    } catch (e) {
      return this.readFailed(o, pos, errorInfo(e).code, "status read failed");
    }
    this.d.ledger.updateOrder(o.id, { signature: null, signed_at: null, blockhash: null, tx_read_failures: 0 });
    return null;
  }

  private apply(o: OrderRow, pos: PositionRow, r: Outcome, err?: unknown): void {
    const now = this.now();
    const fresh = this.d.ledger.order(o.id)!;
    switch (r.kind) {
      case "wait":
        this.d.ledger.updateOrder(o.id, { status: "pending", next_attempt_at: r.untilMs, lease_until: 0, updated_at: now });
        return;
      case "retry": {
        // Attempts are counted where they start (a build that may broadcast); reads that fail cost none.
        const attempts = fresh.attempts;
        this.d.ledger.updateOrder(o.id, { status: "pending", next_attempt_at: now + (r.afterMs ?? this.backoffMs(attempts)), lease_until: 0, last_error_code: r.code, updated_at: now, ...(err ? { last_error: errorJson(err) } : {}) });
        const bucket = attempts >= fresh.max_attempts ? "max" : attempts >= 3 ? "3+" : String(attempts);
        this.alert(`order:${o.id}:attempts:${bucket}`, `order ${o.id} ${o.side} ${pos.mint}: ${attempts}/${fresh.max_attempts} attempts, last ${r.code}`);
        // Never terminal here while something may be live: a persisted signature, or a main-payer build that may have
        // executed (step 3 decides after reading Candle's job).
        const maybeLive = !!fresh.signature || (this.d.rail?.payer?.type === "main" && fresh.ever_signed === 1) || fresh.last_error_code === "IDEMPOTENCY_CONFLICT";
        if (attempts >= fresh.max_attempts && !maybeLive) this.terminal(this.d.ledger.order(o.id)!, "failed", r.code);
        return;
      }
      case "rejected":
        this.terminal(fresh, "rejected", r.code, r.detail);
        return;
      case "reverted":
        this.bookReverted(fresh, pos, r.fill);
        return;
      case "filled":
        this.bookFill(fresh, pos, r.fill, r.result, r.source);
        return;
    }
  }

  private terminal(o: OrderRow, status: "failed" | "rejected" | "reverted", code: string, detail?: string): void {
    this.d.ledger.tx(() => this.terminalTx(o, status, code, detail));
  }

  private terminalTx(o: OrderRow, status: "failed" | "rejected" | "reverted", code: string, detail?: string): void {
    const now = this.now();
    this.d.ledger.updateOrder(o.id, { status, lease_until: 0, last_error_code: code, updated_at: now });
    const pos = this.d.ledger.position(o.position_id)!;
    this.d.log.warn("order_terminal", { order: o.id, side: o.side, mint: pos.mint, status, code, detail, attempts: o.attempts });
    this.alert(`order:${o.id}:${status}`, `order ${o.id} ${o.side} ${pos.mint} ${status} (${code}) after ${o.attempts} attempts`);
    if (o.side === "buy") {
      // No spend landed (rejected / failed with no signature on chain) or only fees (reverted).
      if (pos.status === "opening") this.d.ledger.updatePosition(pos.id, { status: "failed", closed_at: now, note: `buy ${status}: ${code}` });
      return;
    }
    // Only a refusal or a revert says this exit cannot work. Running out of attempts on network errors, timeouts or
    // 5xx does not: the engine mints the next exit on the position's backoff, with no limit.
    if (status === "failed") return;
    const failed = pos.exit_orders_failed + 1;
    const stuck = failed >= this.d.cfg.retry.maxExitOrders;
    this.d.ledger.updatePosition(pos.id, { exit_orders_failed: failed, ...(stuck ? { status: "exit_stuck", note: `exit stuck after ${failed} refused orders (${code})` } : {}) });
    if (stuck) this.alert(`position:${pos.id}:exit_stuck`, `position ${pos.id} ${pos.mint}: exits refused ${failed} times; retrying every ${Math.round(this.d.cfg.retry.stuckRetryMs / 60000)} min, or run \`sell\` by hand`);
  }

  private bookReverted(o: OrderRow, pos: PositionRow, fill: Fill | null): void {
    this.d.ledger.tx(() => {
      const p = this.d.ledger.position(pos.id)!;
      if (fill) this.d.ledger.updatePosition(p.id, { network_fees_lamports: (BigInt(p.network_fees_lamports) + fill.networkFeeLamports).toString() });
      this.d.ledger.updateOrder(o.id, { fill_json: fill ? JSON.stringify(fill, big) : null });
      this.terminal(o, "reverted", "TRADE_REVERTED");
    });
  }

  private bookFill(o: OrderRow, pos: PositionRow, fill: Fill | null, result: any, source: QtySource): void {
    this.d.ledger.tx(() => this.bookFillTx(o, this.d.ledger.position(pos.id)!, fill, result, source));
  }

  private bookFillTx(o: OrderRow, pos: PositionRow, fill: Fill | null, result: any, source: QtySource): void {
    const now = this.now();
    const feeBps = BigInt(o.fee_bps ?? 0);
    let tokenDelta: bigint;
    let swapLamports: bigint;
    let netFee = 0n;
    let rent = 0n;
    if (fill) {
      tokenDelta = fill.tokenDeltaRaw;
      swapLamports = fill.swapLamports;
      netFee = fill.networkFeeLamports;
      rent = fill.rentLamports;
    } else {
      // Fallback (alerted): Candle's amount out. The platform fee rides on top of a buy, out of a sell's proceeds.
      const out = BigInt(result.fallbackOut);
      const amount = BigInt(o.amount_raw);
      if (o.side === "buy") {
        tokenDelta = out;
        swapLamports = -(amount + (amount * feeBps) / 10_000n);
      } else {
        tokenDelta = -amount;
        swapLamports = out - (out * feeBps) / 10_000n;
      }
    }
    const fees = BigInt(pos.network_fees_lamports) + netFee;
    const rentTotal = BigInt(pos.rent_lamports) + rent;
    this.d.ledger.updateOrder(o.id, { status: "filled", qty_source: source, fill_json: JSON.stringify({ fill, result: result ?? null }, big), lease_until: 0, updated_at: now });

    if (o.side === "buy") {
      if (tokenDelta <= 0n && fill) {
        // Read from the real transaction: it landed and the wallet gained nothing.
        this.alert(`order:${o.id}:no_tokens`, `buy ${o.id} landed but the wallet gained no ${pos.mint}`);
        this.d.ledger.updatePosition(pos.id, { status: "failed", closed_at: now, note: "buy landed with no token delta", cost_lamports: (-swapLamports).toString(), network_fees_lamports: fees.toString(), rent_lamports: rentTotal.toString() });
        return;
      }
      const cost = -swapLamports;
      const entry = Number(cost) / 1e9 / (Number(tokenDelta) / 10 ** pos.decimals);
      this.d.ledger.updatePosition(pos.id, { status: "open", qty_raw: tokenDelta.toString(), qty_source: source, remaining_raw: tokenDelta.toString(), cost_lamports: cost.toString(), network_fees_lamports: fees.toString(), rent_lamports: rentTotal.toString(), peak_price: entry });
      this.d.log.info("buy_filled", { position: pos.id, mint: pos.mint, qtyRaw: tokenDelta, costLamports: cost, qtySource: source, signature: fill?.signature ?? null });
      if (source !== "onchain" && source !== "dry") this.alert(`position:${pos.id}:qty_source:${source}`, `position ${pos.id} quantity booked from ${source}`);
      return;
    }
    const sold = -tokenDelta;
    const remaining = BigInt(pos.remaining_raw) - (sold > 0n ? sold : 0n);
    const proceeds = BigInt(pos.proceeds_lamports) + swapLamports;
    const closed = remaining <= 0n;
    this.d.ledger.updatePosition(pos.id, {
      remaining_raw: (remaining > 0n ? remaining : 0n).toString(),
      proceeds_lamports: proceeds.toString(),
      network_fees_lamports: fees.toString(),
      rent_lamports: rentTotal.toString(),
      // A filled sell (manual or the slow exit_stuck retry) shows the exit works again: clear the count.
      ...(closed ? { status: "closed", closed_at: now } : { status: pos.status === "exit_stuck" ? "open" : pos.status }),
      exit_orders_failed: 0,
    });
    this.d.log.info("sell_filled", { position: pos.id, mint: pos.mint, soldRaw: sold, proceedsLamports: swapLamports, remainingRaw: remaining > 0n ? remaining : 0n, closed, qtySource: source, signature: fill?.signature ?? null });
  }

  private async dryAttempt(o: OrderRow, pos: PositionRow): Promise<void> {
    const n = o.attempts + 1;
    this.d.ledger.updateOrder(o.id, { attempts: n, updated_at: this.now() });
    const att = this.d.ledger.startAttempt(o.id, n, this.now());
    if (!this.d.dry) throw new Error("dry order without a pricer");
    try {
      const amount = BigInt(o.amount_raw);
      let fill: Fill;
      if (o.side === "buy") {
        const out = await this.d.dry.buyOut(pos.mint, amount);
        fill = { signature: "dry", slot: null, blockTimeMs: this.now(), tokenDeltaRaw: out, solDeltaLamports: -amount, networkFeeLamports: 0n, rentLamports: 0n, swapLamports: -amount, err: null };
      } else {
        const out = await this.d.dry.sellOut(pos.mint, amount, pos.decimals);
        fill = { signature: "dry", slot: null, blockTimeMs: this.now(), tokenDeltaRaw: -amount, solDeltaLamports: out, networkFeeLamports: 0n, rentLamports: 0n, swapLamports: out, err: null };
      }
      this.d.ledger.endAttempt(att, this.now(), "filled", null, null);
      this.bookFill(this.d.ledger.order(o.id)!, pos, fill, null, "dry");
    } catch (e) {
      const info = errorInfo(e);
      this.d.ledger.endAttempt(att, this.now(), "error:dry", info.code, errorJson(e));
      this.apply(this.d.ledger.order(o.id)!, pos, n >= o.max_attempts ? { kind: "rejected", code: info.code, detail: "dry quote failed" } : { kind: "retry", code: info.code, detail: "dry quote failed", afterMs: this.backoffMs(n) }, e);
    }
  }

  private alert(key: string, message: string): void {
    this.d.alerter.raise(key, message);
  }
}

function big(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
