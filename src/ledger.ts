/**
 * Local SQLite ledger (node:sqlite, no native addon). Raw token and lamport amounts are stored as decimal TEXT
 * and handled as bigint. One process owns a state dir (a lock file guards it); claims are still single
 * statements so a second sweeper could never take the same order.
 */
import { DatabaseSync } from "node:sqlite";

export type PositionStatus = "opening" | "open" | "closed" | "failed" | "exit_stuck";
export type OrderStatus = "pending" | "inflight" | "filled" | "rejected" | "reverted" | "failed";
export type Side = "buy" | "sell";
export type QtySource = "onchain" | "server" | "minout" | "wallet" | "dry";

export interface PositionRow {
  id: number;
  mint: string;
  chain: string;
  status: PositionStatus;
  dry: number;
  opened_at: number;
  closed_at: number | null;
  decimals: number;
  qty_raw: string;
  qty_source: QtySource | null;
  remaining_raw: string;
  cost_lamports: string;
  proceeds_lamports: string;
  network_fees_lamports: string;
  peak_price: number;
  last_price: number | null;
  exit_orders_failed: number;
  strategy: string;
  launch_json: string;
  note: string | null;
  /** Lamports moved into (or back out of) token accounts by this position's fills: rent, a cost until reclaimed. */
  rent_lamports: string;
  /** Tokens written off because the wallet held less than booked (not sold; excluded from soldFraction). */
  written_down_raw: string;
}

export interface OrderRow {
  id: number;
  position_id: number;
  side: Side;
  client_trade_id: string;
  amount_raw: string;
  slippage_bps: number;
  status: OrderStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  lease_until: number;
  created_at: number;
  updated_at: number;
  reason: string;
  signature: string | null;
  signed_at: number | null;
  last_error_code: string | null;
  last_error: string | null;
  fill_json: string | null;
  qty_source: QtySource | null;
  manual: number;
  /** Buys only: past this time no new attempt is built (the filter's decision is stale). */
  deadline_at: number | null;
  expected_out_raw: string | null;
  min_out_raw: string | null;
  /** Status / job reads that failed for this order (no attempt spent; alerted in buckets). */
  read_failures: number;
  /** Reads of a landed transaction that failed (capped by TX_READ_CAP before booking from Candle's numbers). */
  tx_read_failures: number;
  /** 1 once any attempt of this order produced a signed transaction: it can no longer be assumed unspent. */
  ever_signed: number;
  /** The recent blockhash of the persisted signature's transaction (its death is judged on chain from it). */
  blockhash: string | null;
  /** Candle's platform fee rate on this order's build. */
  fee_bps: number | null;
  /** 1 when Candle's job reported this order's signature confirmed: it is never cleared. */
  candle_confirmed: number;
  /** 1 once the one same-id check build at the attempt cap has been used (payer main, failed job). */
  final_check: number;
  /** When Candle's job was first seen `built` for this order (payer main), and whether the one probe ran. */
  built_seen_at: number | null;
  probed: number;
  /** A buy that is ending (JSON {status, code, detail}): from then on only the wallet/tx scan runs, never a build. */
  ending: string | null;
  /** Re-scans of the wallet for this ending buy's tokens (RPC lag), bounded by ADOPT_SCAN_CAP. */
  adopt_scans: number;
  /** More signatures booked to this order (a double execution), JSON list. */
  extra_signatures: string | null;
  /** Attempts that threw inside the executor (alerted in buckets). */
  internal_errors: number;
}

export interface LaunchRow {
  mint: string;
  chain: string;
  first_source: string;
  first_seen_at: number;
  launched_at: number | null;
  api_seen_at: number | null;
  chain_seen_at: number | null;
  api_latency_ms: number | null;
  chain_latency_ms: number | null;
  symbol: string | null;
  name: string | null;
  creator: string | null;
  launch_mode: string | null;
  decision: string | null;
  reason: string | null;
}

const SCHEMA = `
create table if not exists positions (
  id integer primary key,
  mint text not null, chain text not null, status text not null, dry integer not null,
  opened_at integer not null, closed_at integer, decimals integer not null,
  qty_raw text not null default '0', qty_source text, remaining_raw text not null default '0',
  cost_lamports text not null default '0', proceeds_lamports text not null default '0', network_fees_lamports text not null default '0',
  peak_price real not null default 0, last_price real, exit_orders_failed integer not null default 0,
  strategy text not null, launch_json text not null, note text
);
create index if not exists positions_status on positions(status);
create index if not exists positions_mint on positions(mint);
create table if not exists orders (
  id integer primary key,
  position_id integer not null references positions(id), side text not null,
  client_trade_id text not null unique, amount_raw text not null, slippage_bps integer not null,
  status text not null, attempts integer not null default 0, max_attempts integer not null,
  next_attempt_at integer not null, lease_until integer not null default 0,
  created_at integer not null, updated_at integer not null, reason text not null,
  signature text, signed_at integer, last_error_code text, last_error text, fill_json text, qty_source text,
  manual integer not null default 0
);
create index if not exists orders_status on orders(status, next_attempt_at);
create table if not exists attempts (
  id integer primary key, order_id integer not null references orders(id), n integer not null,
  started_at integer not null, ended_at integer, outcome text, error_code text, error_json text
);
create table if not exists launches (
  mint text primary key, chain text not null, first_source text not null, first_seen_at integer not null,
  launched_at integer, api_seen_at integer, chain_seen_at integer, api_latency_ms integer, chain_latency_ms integer,
  symbol text, name text, creator text, launch_mode text, decision text, reason text
);
create table if not exists alerts (
  key text primary key, first_at integer not null, last_at integer not null, count integer not null, message text not null
);
`;

export class Ledger {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = full; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const cols = new Set((this.db.prepare("pragma table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [c, ddl] of [["deadline_at", "integer"], ["expected_out_raw", "text"], ["min_out_raw", "text"], ["read_failures", "integer not null default 0"],
      ["tx_read_failures", "integer not null default 0"], ["ever_signed", "integer not null default 0"], ["blockhash", "text"], ["fee_bps", "integer"],
      ["candle_confirmed", "integer not null default 0"], ["final_check", "integer not null default 0"], ["built_seen_at", "integer"], ["probed", "integer not null default 0"],
      ["ending", "text"], ["adopt_scans", "integer not null default 0"], ["extra_signatures", "text"], ["internal_errors", "integer not null default 0"]] as const)
      if (!cols.has(c)) this.db.exec(`alter table orders add column ${c} ${ddl}`);
    const pcols = new Set((this.db.prepare("pragma table_info(positions)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [c, ddl] of [["rent_lamports", "text not null default '0'"], ["written_down_raw", "text not null default '0'"]] as const)
      if (!pcols.has(c)) this.db.exec(`alter table positions add column ${c} ${ddl}`);
  }

  /** The modes (dry / live) this ledger already holds positions for. */
  modes(): { dry: boolean; live: boolean } {
    const r = this.db.prepare("select sum(dry = 1) d, sum(dry = 0) l from positions").get() as { d: number | null; l: number | null };
    return { dry: Number(r.d ?? 0) > 0, live: Number(r.l ?? 0) > 0 };
  }

  close(): void {
    this.db.close();
  }

  /** A transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("begin immediate");
    this.depth = 1;
    try {
      const r = fn();
      this.db.exec("commit");
      return r;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  // ---------------------------------------------------------------- positions
  createPosition(p: { mint: string; chain: string; dry: boolean; now: number; decimals: number; strategy: string; launch: unknown; note?: string }): number {
    const r = this.db
      .prepare("insert into positions (mint, chain, status, dry, opened_at, decimals, strategy, launch_json, note) values (?, ?, 'opening', ?, ?, ?, ?, ?, ?)")
      .run(p.mint, p.chain, p.dry ? 1 : 0, p.now, p.decimals, p.strategy, JSON.stringify(p.launch ?? null), p.note ?? null);
    return Number(r.lastInsertRowid);
  }

  position(id: number): PositionRow | undefined {
    return this.db.prepare("select * from positions where id = ?").get(id) as PositionRow | undefined;
  }

  positionsByStatus(...statuses: PositionStatus[]): PositionRow[] {
    const q = `select * from positions where status in (${statuses.map(() => "?").join(",")}) order by id`;
    return this.db.prepare(q).all(...statuses) as unknown as PositionRow[];
  }

  allPositions(): PositionRow[] {
    return this.db.prepare("select * from positions order by id").all() as unknown as PositionRow[];
  }

  /** Entries in a coin that may hold or have held tokens: every position except a buy that definitely never landed. */
  entriesForMint(mint: string, dry: boolean): number {
    const r = this.db
      .prepare(
        `select count(*) n from positions p where p.mint = ? and p.dry = ?
           and not (p.status = 'failed' and not exists (select 1 from orders o where o.position_id = p.id and o.side = 'buy'
                    and not (o.status = 'reverted' or (o.status = 'rejected' and o.ever_signed = 0))))`,
      )
      .get(mint, dry ? 1 : 0) as { n: number };
    return Number(r.n);
  }

  updatePosition(id: number, fields: Partial<Omit<PositionRow, "id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`update positions set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`).run(...keys.map((k) => (fields as any)[k]), id);
  }

  // ---------------------------------------------------------------- orders
  createOrder(o: { positionId: number; side: Side; clientTradeId: string; amountRaw: bigint; slippageBps: number; maxAttempts: number; now: number; reason: string; manual?: boolean; deadlineAt?: number | null; expectedOutRaw?: bigint | null }): number {
    const r = this.db
      .prepare(
        "insert into orders (position_id, side, client_trade_id, amount_raw, slippage_bps, status, max_attempts, next_attempt_at, created_at, updated_at, reason, manual, deadline_at, expected_out_raw) values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(o.positionId, o.side, o.clientTradeId, o.amountRaw.toString(), o.slippageBps, o.maxAttempts, o.now, o.now, o.now, o.reason, o.manual ? 1 : 0, o.deadlineAt ?? null, o.expectedOutRaw == null ? null : o.expectedOutRaw.toString());
    return Number(r.lastInsertRowid);
  }

  order(id: number): OrderRow | undefined {
    return this.db.prepare("select * from orders where id = ?").get(id) as OrderRow | undefined;
  }

  ordersFor(positionId: number): OrderRow[] {
    return this.db.prepare("select * from orders where position_id = ? order by id").all(positionId) as unknown as OrderRow[];
  }

  openOrderFor(positionId: number): OrderRow | undefined {
    return this.db.prepare("select * from orders where position_id = ? and status in ('pending','inflight') order by id limit 1").get(positionId) as OrderRow | undefined;
  }

  /** Claim due orders in one statement: lease them so no other sweep (or a restart) re-runs them mid-attempt. */
  claimDue(now: number, leaseMs: number, limit = 5, opts: { dryOnly?: boolean; onlyIds?: number[]; excludeIds?: number[]; side?: "buy" | "sell"; reconcileOnly?: boolean } = {}): OrderRow[] {
    const ex = opts.excludeIds?.length ? `and o.id not in (${opts.excludeIds.map((i) => Number(i)).join(",")})` : "";
    const rec = opts.reconcileOnly ? "and (o.signature is not null or o.ever_signed = 1)" : "";
    const ids = opts.onlyIds?.length ? `and o.id in (${opts.onlyIds.map((i) => Number(i)).join(",")})` : "";
    const side = opts.side === "buy" ? "and o.side = 'buy'" : opts.side === "sell" ? "and o.side = 'sell'" : "";
    return this.db
      .prepare(
        `update orders set status = 'inflight', lease_until = ?, updated_at = ?
          where id in (select o.id from orders o join positions p on p.id = o.position_id
                        where ((o.status = 'pending' and o.next_attempt_at <= ?) or (o.status = 'inflight' and o.lease_until <= ?))
                          and (? = 0 or p.dry = 1) ${ids} ${ex} ${side} ${rec}
                        order by (o.side = 'sell') desc, o.next_attempt_at limit ?)
          returning *`,
      )
      .all(now + leaseMs, now, now, now, opts.dryOnly ? 1 : 0, limit) as unknown as OrderRow[];
  }

  updateOrder(id: number, fields: Partial<Omit<OrderRow, "id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`update orders set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`).run(...keys.map((k) => (fields as any)[k]), id);
  }

  startAttempt(orderId: number, n: number, now: number): number {
    const r = this.db.prepare("insert into attempts (order_id, n, started_at) values (?, ?, ?)").run(orderId, n, now);
    return Number(r.lastInsertRowid);
  }

  endAttempt(id: number, now: number, outcome: string, code: string | null, errorJson: string | null): void {
    this.db.prepare("update attempts set ended_at = ?, outcome = ?, error_code = ?, error_json = ? where id = ?").run(now, outcome, code, errorJson, id);
  }

  attemptsFor(orderId: number): Array<{ n: number; started_at: number; ended_at: number | null; outcome: string | null; error_code: string | null; error_json: string | null }> {
    return this.db.prepare("select n, started_at, ended_at, outcome, error_code, error_json from attempts where order_id = ? order by id").all(orderId) as any;
  }

  /**
   * Lamports committed to buys (tickets; Candle's platform fee comes on top): every buy order except a revert (fees
   * only) and a rejection proven unspent (never signed). A rejection after something was signed still counts.
   */
  lifetimeBuyLamports(dry: boolean): bigint {
    const rows = this.db
      .prepare("select o.amount_raw a, o.extra_signatures x from orders o join positions p on p.id = o.position_id where o.side = 'buy' and o.status != 'reverted' and not (o.status = 'rejected' and o.ever_signed = 0) and p.dry = ?")
      .all(dry ? 1 : 0) as Array<{ a: string; x: string | null }>;
    // A double execution spent one ticket per transaction.
    return rows.reduce((s, r) => s + BigInt(r.a) * BigInt(1 + (r.x ? (JSON.parse(r.x) as unknown[]).length : 0)), 0n);
  }

  queueHealth(now: number, dry: boolean): { pending: number; inflight: number; oldestAgeMs: number | null; maxAttempts: number; terminalFailed: number; stuckPositions: number } {
    const d = dry ? 1 : 0;
    const q = this.db.prepare("select o.status status, count(*) n, min(o.created_at) oldest, max(o.attempts) att from orders o join positions p on p.id = o.position_id where o.status in ('pending','inflight') and p.dry = ? group by o.status").all(d) as any[];
    const pending = Number(q.find((r) => r.status === "pending")?.n ?? 0);
    const inflight = Number(q.find((r) => r.status === "inflight")?.n ?? 0);
    const oldest = q.reduce((m: number | null, r) => (r.oldest !== null && (m === null || r.oldest < m) ? r.oldest : m), null);
    const att = q.reduce((m: number, r) => Math.max(m, Number(r.att ?? 0)), 0);
    const failed = Number((this.db.prepare("select count(*) n from orders o join positions p on p.id = o.position_id where o.status = 'failed' and p.dry = ?").get(d) as any).n);
    const stuck = Number((this.db.prepare("select count(*) n from positions where status = 'exit_stuck' and dry = ?").get(d) as any).n);
    return { pending, inflight, oldestAgeMs: oldest === null ? null : now - oldest, maxAttempts: att, terminalFailed: failed, stuckPositions: stuck };
  }

  /** Every signature already booked to an order (so a found transaction is never booked twice). */
  bookedSignatures(): string[] {
    const rows = this.db.prepare("select signature s, extra_signatures x from orders where signature is not null and status in ('filled','reverted')").all() as Array<{ s: string; x: string | null }>;
    const out: string[] = [];
    for (const r of rows) {
      out.push(r.s);
      if (r.x) for (const e of JSON.parse(r.x) as string[]) out.push(e);
    }
    return out;
  }

  // ---------------------------------------------------------------- launches
  recordLaunch(l: LaunchRow): void {
    this.db
      .prepare(
        `insert into launches (mint, chain, first_source, first_seen_at, launched_at, api_seen_at, chain_seen_at, api_latency_ms, chain_latency_ms, symbol, name, creator, launch_mode, decision, reason)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(mint) do update set
           launched_at = coalesce(excluded.launched_at, launches.launched_at),
           api_seen_at = coalesce(launches.api_seen_at, excluded.api_seen_at),
           chain_seen_at = coalesce(launches.chain_seen_at, excluded.chain_seen_at),
           api_latency_ms = coalesce(excluded.api_latency_ms, launches.api_latency_ms),
           chain_latency_ms = coalesce(excluded.chain_latency_ms, launches.chain_latency_ms),
           symbol = coalesce(excluded.symbol, launches.symbol), name = coalesce(excluded.name, launches.name),
           creator = coalesce(excluded.creator, launches.creator), launch_mode = coalesce(excluded.launch_mode, launches.launch_mode),
           decision = coalesce(excluded.decision, launches.decision), reason = coalesce(excluded.reason, launches.reason)`,
      )
      .run(l.mint, l.chain, l.first_source, l.first_seen_at, l.launched_at, l.api_seen_at, l.chain_seen_at, l.api_latency_ms, l.chain_latency_ms, l.symbol, l.name, l.creator, l.launch_mode, l.decision, l.reason);
  }

  launch(mint: string): LaunchRow | undefined {
    return this.db.prepare("select * from launches where mint = ?").get(mint) as LaunchRow | undefined;
  }

  recentLaunches(limit = 20): LaunchRow[] {
    return this.db.prepare("select * from launches order by first_seen_at desc limit ?").all(limit) as unknown as LaunchRow[];
  }

  // ---------------------------------------------------------------- alerts
  /** Count an alert under a key that carries the worsening dimension; returns true when it should be announced. */
  alert(key: string, message: string, now: number, renotifyMs = 86_400_000): boolean {
    const r = this.db.prepare("select * from alerts where key = ?").get(key) as any;
    if (!r) {
      this.db.prepare("insert into alerts (key, first_at, last_at, count, message) values (?, ?, ?, 1, ?)").run(key, now, now, message);
      return true;
    }
    const due = now - r.last_at >= renotifyMs;
    this.db.prepare("update alerts set count = count + 1, message = ?, last_at = case when ? then ? else last_at end where key = ?").run(message, due ? 1 : 0, now, key);
    return due;
  }
}
