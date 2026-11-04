// Stale coin: after `afterSec`, if the price is still within `band` of the
// entry (0.2 = between 0.8x and 1.2x), sell it all. Coins that ran or dumped are left to the rest of your plan.
// Use: "exit": { "strategy": "stale-coin", "module": "./stale-coin.js", "afterSec": 1800, "band": 0.2 }
/** @param {Record<string, unknown>} params */
export function create(params) {
  const afterSec = Number(params.afterSec ?? 1800);
  const band = Number(params.band ?? 0.2);
  if (!(afterSec > 0) || !(band > 0 && band < 1)) throw new Error("stale-coin: need afterSec > 0 and 0 < band < 1");
  return {
    name: "stale-coin",
    onTick(p, m) {
      if (m.priceSol === null || !(p.entryPriceSol > 0)) return { action: "hold" };
      if (m.nowMs - p.openedAtMs < afterSec * 1000) return { action: "hold" };
      const x = m.priceSol / p.entryPriceSol;
      return Math.abs(x - 1) <= band ? { action: "sell", fraction: 1, reason: `flat ${x.toFixed(2)}x after ${afterSec}s` } : { action: "hold" };
    },
  };
}
