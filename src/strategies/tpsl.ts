/**
 * tpsl: take profit / stop loss as multiples of the entry price; sells the whole remaining position.
 *   { "strategy": "tpsl", "takeProfit": 2.0, "stopLoss": 0.5, "trailing": 0.3 }
 * takeProfit: sell at >= this multiple (e.g. 2.0 = 2x). stopLoss: sell at <= this multiple (e.g. 0.5 = -50 %).
 * trailing (optional): also sell when price falls this fraction from its peak since entry, once above entry.
 */
import { HOLD, checkParams, multiple, param, StrategyConfigError, type ExitStrategy } from "./types.ts";

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, ["takeProfit", "stopLoss", "trailing"], "tpsl");
  const tp = params.takeProfit === undefined ? Infinity : param(params, "takeProfit", "tpsl", { exclusiveMin: 1 });
  const sl = params.stopLoss === undefined ? 0 : param(params, "stopLoss", "tpsl", { min: 0, max: 1 });
  const trail = params.trailing === undefined ? null : param(params, "trailing", "tpsl", { exclusiveMin: 0, max: 1 });
  if (tp === Infinity && sl === 0 && trail === null) throw new StrategyConfigError("exit (tpsl): set takeProfit, stopLoss or trailing");
  return {
    name: "tpsl",
    onTick(p, m) {
      const x = multiple(p, m);
      if (x === null) return HOLD;
      if (x >= tp) return { action: "sell", fraction: 1, reason: `take_profit ${x.toFixed(3)}x` };
      if (sl > 0 && x <= sl) return { action: "sell", fraction: 1, reason: `stop_loss ${x.toFixed(3)}x` };
      if (trail !== null && m.priceSol !== null && p.peakPriceSol > p.entryPriceSol && m.priceSol <= p.peakPriceSol * (1 - trail))
        return { action: "sell", fraction: 1, reason: `trailing ${(m.priceSol / p.peakPriceSol).toFixed(3)} of peak` };
      return HOLD;
    },
  };
}
