/**
 * preGrad: sell before graduation, at a graduation-progress threshold of the launch curve. Graduated Candle
 * coins sell only through Jupiter, and exp-custom pools often sit at their floor with no route, so this exit
 * acts while the curve can still take the sell.
 *   { "strategy": "preGrad", "progress": 0.8, "fraction": 1, "stopLoss": 0.5 }
 * fraction (default 1): share of the remaining position sold at the threshold. stopLoss (optional) as in tpsl.
 * A coin that migrates before the threshold sell sells the same `fraction` then; the core is kept.
 */
import { HOLD, checkParams, multiple, param, type ExitStrategy } from "./types.ts";

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, ["progress", "fraction", "stopLoss"], "preGrad");
  const at = param(params, "progress", "preGrad", { exclusiveMin: 0, max: 1 });
  const fraction = param(params, "fraction", "preGrad", { exclusiveMin: 0, max: 1, def: 1 });
  const sl = params.stopLoss === undefined ? 0 : param(params, "stopLoss", "preGrad", { min: 0, max: 1 });
  return {
    name: "preGrad",
    onTick(p, m) {
      const x = multiple(p, m);
      if (sl > 0 && x !== null && x <= sl) return { action: "sell", fraction: 1, reason: `stop_loss ${x.toFixed(3)}x` };
      // Migrated before the threshold sell happened: sell the same share now; the core is kept either way.
      if (m.migrated) return p.soldFraction < 1e-9 ? { action: "sell", fraction, reason: "migrated" } : HOLD;
      if (m.progress === null) return HOLD;
      // One sell at the threshold: once part of the position is sold, the rest is held (fraction < 1 keeps a core).
      if (m.progress >= at && p.soldFraction < 1e-9) return { action: "sell", fraction, reason: `progress ${(m.progress * 100).toFixed(1)} %` };
      return HOLD;
    },
  };
}
