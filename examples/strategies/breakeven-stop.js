// Break-even stop: no stop at first; once the price has reached `arm` x the entry, a fall back to `floor` x the
// entry (default 1.0, break-even) sells everything. Optional `takeProfit` sells `tpFraction` at that multiple once.
// Use: "exit": { "strategy": "breakeven-stop", "module": "./breakeven-stop.js", "arm": 1.5, "floor": 1.0 }
/** @param {Record<string, unknown>} params */
export function create(params) {
  const arm = Number(params.arm ?? 1.5);
  const floor = Number(params.floor ?? 1.0);
  const tp = params.takeProfit === undefined ? Infinity : Number(params.takeProfit);
  const tpFraction = Number(params.tpFraction ?? 0.5);
  if (!(arm > 1) || !(floor > 0) || !(floor < arm)) throw new Error("breakeven-stop: need arm > 1 and 0 < floor < arm");
  return {
    name: "breakeven-stop",
    onTick(p, m) {
      if (m.priceSol === null || !(p.entryPriceSol > 0)) return { action: "hold" };
      const x = m.priceSol / p.entryPriceSol;
      const peak = p.peakPriceSol / p.entryPriceSol;
      if (p.soldFraction === 0 && x >= tp) return { action: "sell", fraction: tpFraction, reason: `tp ${tp}x` };
      if (peak >= arm && x <= floor) return { action: "sell", fraction: 1, reason: `fell back to ${floor}x after ${arm}x` };
      return { action: "hold" };
    },
  };
}
