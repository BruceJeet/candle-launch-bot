/**
 * Exit strategies. One file per strategy in this folder, exporting `create(params)`; the engine loads it by the
 * config's `exit.strategy` name. Adding a strategy is one new file and no engine change.
 *
 * `onTick` is called once per cycle for each open position that has no exit order in flight. It returns
 * `hold` or `sell` with a fraction of the position's REMAINING quantity (0 < fraction <= 1).
 */
export interface PositionView {
  mint: string;
  openedAtMs: number;
  /** Tokens booked at entry (raw units, from the on-chain fill). */
  qtyRaw: bigint;
  /** Tokens still held by this position (raw). */
  remainingRaw: bigint;
  decimals: number;
  /** SOL per whole token paid at entry, all-in (cost / quantity). */
  entryPriceSol: number;
  /** Highest market price seen since entry (SOL per whole token). */
  peakPriceSol: number;
  /** Share of the original quantity already sold, 0..1. */
  soldFraction: number;
}

export interface MarketView {
  /** SOL per whole token now, or null when unreadable this cycle. */
  priceSol: number | null;
  /** Graduation progress 0..1 while on the curve; 1 once migrated; null when unknown. */
  progress: number | null;
  migrated: boolean;
  venue: "curve" | "damm" | "unknown";
  nowMs: number;
}

export type Decision = { action: "hold" } | { action: "sell"; fraction: number; reason: string };

export interface ExitStrategy {
  readonly name: string;
  onTick(position: PositionView, market: MarketView): Decision;
}

export type StrategyFactory = (params: Record<string, unknown>) => ExitStrategy;

export const HOLD: Decision = { action: "hold" };

export class StrategyConfigError extends Error {}

/** Shared parameter checks: unknown keys refused, numbers range-checked. */
export function checkParams(params: Record<string, unknown>, allowed: string[], name: string): void {
  for (const k of Object.keys(params)) if (k !== "strategy" && !allowed.includes(k)) throw new StrategyConfigError(`exit (${name}): unknown key "${k}"`);
}

export function param(params: Record<string, unknown>, key: string, name: string, opts: { min?: number; max?: number; def?: number; exclusiveMin?: number } = {}): number {
  const v = params[key];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    throw new StrategyConfigError(`exit (${name}).${key}: required`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new StrategyConfigError(`exit (${name}).${key}: must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new StrategyConfigError(`exit (${name}).${key}: must be >= ${opts.min}`);
  if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) throw new StrategyConfigError(`exit (${name}).${key}: must be > ${opts.exclusiveMin}`);
  if (opts.max !== undefined && v > opts.max) throw new StrategyConfigError(`exit (${name}).${key}: must be <= ${opts.max}`);
  return v;
}

export function multiple(p: PositionView, m: MarketView): number | null {
  if (m.priceSol === null || !(p.entryPriceSol > 0)) return null;
  return m.priceSol / p.entryPriceSol;
}
