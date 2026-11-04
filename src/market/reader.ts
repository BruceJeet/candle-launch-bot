/** Market reads for a set of coins in one RPC round trip: the Candle curve, and the DAMM v2 pool once migrated. */
import { candleCurve, dammPool } from "../solana/pda.ts";
import { getAccounts, type Rpc } from "../solana/rpc.ts";
import { buyImpact, curveProgress, dammPrice, dammRoomAboveFloor, decodeCandleCurve, decodeDamm, priceFromSqrt, type CandleCurve } from "./curve.ts";
import type { MarketView } from "../strategies/types.ts";
import type { DryPricer } from "../exec/executor.ts";

export interface MarketRead extends MarketView {
  mint: string;
  curve: CandleCurve | null;
  roomAboveFloor: number | null;
  problem?: string;
}

export interface CoinRef {
  mint: string;
  decimals: number;
}

const pdaCache = new Map<string, { curve: string; pool: string }>();
function pdas(mint: string) {
  let p = pdaCache.get(mint);
  if (!p) {
    p = { curve: candleCurve(mint), pool: dammPool(mint) };
    pdaCache.set(mint, p);
  }
  return p;
}

export async function readMarkets(rpc: Rpc, coins: CoinRef[], nowMs: number): Promise<Map<string, MarketRead>> {
  const out = new Map<string, MarketRead>();
  if (!coins.length) return out;
  const keys: string[] = [];
  for (const c of coins) keys.push(pdas(c.mint).curve, pdas(c.mint).pool);
  const vals = await getAccounts(rpc, keys);
  coins.forEach((c, i) => {
    const cv = vals[2 * i];
    const pv = vals[2 * i + 1];
    const base: MarketRead = { mint: c.mint, priceSol: null, progress: null, migrated: false, venue: "unknown", nowMs, curve: null, roomAboveFloor: null };
    try {
      const curve = decodeCandleCurve(cv);
      if (curve.baseMint !== c.mint) throw new Error("curve_mismatch");
      base.curve = curve;
      base.progress = curveProgress(curve);
      base.migrated = curve.migrated;
      if (!curve.migrated && base.progress >= 1) {
        // Full but not flagged migrated yet: the graduating swap is done and the pool is not there. Hold.
        base.problem = "migrating";
      } else if (!curve.migrated) {
        base.venue = "curve";
        base.priceSol = curve.sqrtPrice ? priceFromSqrt(curve.sqrtPrice, c.decimals) : null;
      } else if (pv) {
        const pool = decodeDamm(pv);
        if (pool.creator !== curve.authority) throw new Error("pool_mismatch");
        base.venue = "damm";
        base.priceSol = dammPrice(pool, c.mint, c.decimals);
        base.roomAboveFloor = dammRoomAboveFloor(pool);
      } else {
        base.problem = "migrating";
      }
    } catch (e) {
      base.problem = (e as Error).message;
    }
    out.set(c.mint, base);
  });
  return out;
}

export function impactBps(curve: CandleCurve, lamports: bigint): { bps: number; expectedOutRaw: bigint } | { error: string } {
  try {
    const r = buyImpact(curve, lamports);
    return { bps: r.impactBps, expectedOutRaw: r.expectedOutRaw };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface QuoteSource {
  getQuote(chain: "solana", mint: string, q: { side: "buy" | "sell"; amountIn: string; slippageBps?: number }): Promise<{ quote: { amountOut: string } }>;
}

/**
 * Dry-run fills: Candle's public curve quote (exact integers) while the coin is on the curve; the on-chain
 * curve math as a fallback; for a migrated coin, the pool price less 2 % (labelled dry in the ledger).
 */
export function dryPricer(rpc: Rpc, quotes: QuoteSource | null, decimalsOf: (mint: string) => number): DryPricer {
  return {
    async buyOut(mint, lamports) {
      if (quotes) {
        try {
          const q = await quotes.getQuote("solana", mint, { side: "buy", amountIn: lamports.toString() });
          return BigInt(q.quote.amountOut);
        } catch {
          /* fall back to the curve */
        }
      }
      const m = (await readMarkets(rpc, [{ mint, decimals: decimalsOf(mint) }], Date.now())).get(mint)!;
      if (!m.curve) throw Object.assign(new Error("no curve"), { code: "NO_MARKET" });
      return buyImpact(m.curve, lamports).expectedOutRaw;
    },
    async sellOut(mint, raw, decimals) {
      if (quotes) {
        try {
          const q = await quotes.getQuote("solana", mint, { side: "sell", amountIn: raw.toString() });
          return BigInt(q.quote.amountOut);
        } catch {
          /* graduated or unavailable: mark to market */
        }
      }
      const m = (await readMarkets(rpc, [{ mint, decimals }], Date.now())).get(mint)!;
      if (m.priceSol === null) throw Object.assign(new Error("no price"), { code: "NO_MARKET" });
      return BigInt(Math.floor((Number(raw) / 10 ** decimals) * m.priceSol * 1e9 * 0.98));
    },
  };
}
