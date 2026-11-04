/**
 * ladder: sell fractions of the ORIGINAL position at price multiples, keep the rest as a core.
 *   { "strategy": "ladder", "rungs": [{ "at": 2, "sell": 0.25 }, { "at": 4, "sell": 0.25 }], "stopLoss": 0.4 }
 * Rungs are cumulative targets: at 4x the position has sold 0.5 of its original size in all. The core
 * (1 - sum of sells) is held, except that stopLoss (optional) sells whatever remains at <= that multiple.
 */
import { HOLD, checkParams, multiple, param, StrategyConfigError, type ExitStrategy } from "./types.ts";

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, ["rungs", "stopLoss"], "ladder");
  const raw = params.rungs;
  if (!Array.isArray(raw) || raw.length === 0) throw new StrategyConfigError("exit (ladder).rungs: a non-empty list of { at, sell }");
  const rungs = raw.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new StrategyConfigError(`exit (ladder).rungs[${i}]: { at, sell }`);
    checkParams(r as Record<string, unknown>, ["at", "sell"], `ladder.rungs[${i}]`);
    return { at: param(r as any, "at", `ladder.rungs[${i}]`, { exclusiveMin: 0 }), sell: param(r as any, "sell", `ladder.rungs[${i}]`, { exclusiveMin: 0, max: 1 }) };
  });
  for (let i = 1; i < rungs.length; i++) if (rungs[i].at <= rungs[i - 1].at) throw new StrategyConfigError("exit (ladder).rungs: `at` must increase");
  const total = rungs.reduce((s, r) => s + r.sell, 0);
  if (total > 1 + 1e-9) throw new StrategyConfigError("exit (ladder).rungs: sells add up to more than 1");
  const sl = params.stopLoss === undefined ? 0 : param(params, "stopLoss", "ladder", { min: 0, max: 1 });
  return {
    name: "ladder",
    onTick(p, m) {
      const x = multiple(p, m);
      if (x === null || p.remainingRaw <= 0n) return HOLD;
      if (sl > 0 && x <= sl) return { action: "sell", fraction: 1, reason: `stop_loss ${x.toFixed(3)}x` };
      let target = 0;
      let hit: number | null = null;
      for (const r of rungs) if (x >= r.at) { target += r.sell; hit = r.at; }
      const want = target - p.soldFraction;          // share of the original still to sell to reach the rung
      if (hit === null || want <= 1e-6) return HOLD;
      const remainingFraction = 1 - p.soldFraction;
      if (remainingFraction <= 0) return HOLD;
      const fraction = Math.min(1, want / remainingFraction);
      return { action: "sell", fraction, reason: `ladder ${hit}x (to ${(target * 100).toFixed(0)} % sold)` };
    },
  };
}
