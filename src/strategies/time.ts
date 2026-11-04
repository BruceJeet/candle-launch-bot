/**
 * time: sell everything N seconds after entry.
 *   { "strategy": "time", "afterSec": 300 }
 */
import { HOLD, checkParams, param, type ExitStrategy } from "./types.ts";

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, ["afterSec"], "time");
  const after = param(params, "afterSec", "time", { exclusiveMin: 0 });
  return {
    name: "time",
    onTick(p, m) {
      const age = (m.nowMs - p.openedAtMs) / 1000;
      return age >= after ? { action: "sell", fraction: 1, reason: `time ${Math.round(age)}s` } : HOLD;
    },
  };
}
