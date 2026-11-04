// Time-boxed take-profit: sell everything at `takeProfit` x within `windowSec` of entry; when the window closes, sell
// whatever is left, whatever the price. Use: "exit": { "strategy": "timeboxed-tp", "module": "./timeboxed-tp.js",
// "takeProfit": 2, "windowSec": 600 }
/** @param {Record<string, unknown>} params */
export function create(params) {
  const tp = Number(params.takeProfit ?? 2);
  const windowSec = Number(params.windowSec ?? 600);
  if (!(tp > 1)) throw new Error("timeboxed-tp.takeProfit: must be > 1");
  if (!(windowSec > 0)) throw new Error("timeboxed-tp.windowSec: must be > 0");
  return {
    name: "timeboxed-tp",
    onTick(p, m) {
      if (m.priceSol !== null && p.entryPriceSol > 0 && m.priceSol / p.entryPriceSol >= tp) return { action: "sell", fraction: 1, reason: `tp ${tp}x` };
      if (m.nowMs - p.openedAtMs >= windowSec * 1000) return { action: "sell", fraction: 1, reason: `window ${windowSec}s over` };
      return { action: "hold" };
    },
  };
}
