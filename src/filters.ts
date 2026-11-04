/**
 * Entry filters. A verdict is `buy`, `skip` (final, with a reason), or `wait` (a field the filter needs is
 * not known yet: retried each cycle until it is, or the coin ages past maxAgeSec). Unknown never passes.
 */
import type { Config } from "./config.ts";
import type { Launch } from "./detect/detector.ts";
import type { CandleCurve } from "./market/curve.ts";
import { buyImpact, curveClass } from "./market/curve.ts";
import { WSOL } from "./solana/pda.ts";


export type Verdict = { verdict: "buy"; impactBps: number; expectedOutRaw: bigint } | { verdict: "skip"; reason: string } | { verdict: "wait"; reason: string };

export interface Caps {
  open: number;
  entriesForMint: number;
  lifetimeLamports: bigint;
  paused: boolean;
}

export function lamportsOf(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function evaluate(cfg: Config, l: Launch, curve: CandleCurve | null | "unreadable", caps: Caps, nowMs: number): Verdict {
  const f = cfg.filters;
  if (!f.chains.includes(l.chain)) return { verdict: "skip", reason: `chain ${l.chain}` };
  if (l.launchedAtMs === null) return { verdict: "skip", reason: "launch time unknown" };
  const ageSec = (nowMs - l.launchedAtMs) / 1000;
  if (ageSec > f.maxAgeSec) return { verdict: "skip", reason: `age ${Math.round(ageSec)}s > ${f.maxAgeSec}s` };

  // The bot never buys a launch by its own wallet.
  if (l.creator === cfg.wallet || l.signer === cfg.wallet) return { verdict: "skip", reason: "own wallet's launch" };
  if (f.creatorDeny?.length) {
    const who = [l.creator, l.signer].filter(Boolean) as string[];
    if (who.some((w) => f.creatorDeny!.includes(w))) return { verdict: "skip", reason: "creator denied" };
    if (!l.creator) return { verdict: "wait", reason: "creator unknown (deny list)" };
  }
  if (f.creatorAllow?.length) {
    const who = [l.creator, l.signer].filter(Boolean) as string[];
    if (!who.some((w) => f.creatorAllow!.includes(w))) return l.creator ? { verdict: "skip", reason: "creator not allowed" } : { verdict: "wait", reason: "creator unknown (allow list)" };
  }
  if (!l.launchMode) {
    // A chain-first launch: Candle's list may not have it yet. The curve account says open / exclusive / exp-*.
    if (!f.inferModeFromCurve) return { verdict: "wait", reason: "launch mode unknown" };
    if (curve === null) return { verdict: "wait", reason: "curve not readable yet" };
    if (curve === "unreadable") return { verdict: "skip", reason: "curve unreadable" };
    // Only a full match of the open preset decides here; every other curve waits for Candle's `tier`.
    if (curveClass(curve) !== "open") return { verdict: "wait", reason: "launch mode unknown" };
    if (!f.launchModes.includes("open")) return { verdict: "skip", reason: "mode open (from the curve preset)" };
  } else if (!f.launchModes.includes(l.launchMode)) return { verdict: "skip", reason: `mode ${l.launchMode}` };
  if (f.nameMatch) {
    if (l.name === undefined) return { verdict: "wait", reason: "name unknown" };
    if (!new RegExp(f.nameMatch, "i").test(l.name)) return { verdict: "skip", reason: "name does not match" };
  }
  if (f.symbolMatch) {
    if (l.symbol === undefined) return { verdict: "wait", reason: "symbol unknown" };
    if (!new RegExp(f.symbolMatch, "i").test(l.symbol)) return { verdict: "skip", reason: "symbol does not match" };
  }

  if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
  if (caps.entriesForMint >= cfg.buy.maxPerCoin) return { verdict: "skip", reason: `maxPerCoin ${cfg.buy.maxPerCoin}` };
  if (caps.open >= cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${cfg.buy.maxOpen}` };
  const ticket = lamportsOf(cfg.buy.sol);
  if (caps.lifetimeLamports + ticket > lamportsOf(cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${cfg.buy.lifetimeSol}` };

  if (curve === null) return { verdict: "wait", reason: "curve not readable yet" };
  if (curve === "unreadable") return { verdict: "skip", reason: "curve unreadable" };
  if (curve.baseMint !== l.mint) return { verdict: "skip", reason: "curve names another mint" };
  if (curve.quoteMint !== WSOL) return { verdict: "skip", reason: "curve is not SOL-quoted" };
  if (curve.migrated) return { verdict: "skip", reason: "already graduated" };
  if (curve.quoteReserve >= curve.migrationThreshold) return { verdict: "skip", reason: "curve full (migrating)" };
  let impact: number;
  let expectedOutRaw: bigint;
  try {
    const r = buyImpact(curve, ticket);
    impact = r.impactBps;
    expectedOutRaw = r.expectedOutRaw;
  } catch (e) {
    return { verdict: "skip", reason: (e as Error).message };
  }
  if (impact > f.maxImpactBps) return { verdict: "skip", reason: `impact ${impact} bps > ${f.maxImpactBps}` };
  return { verdict: "buy", impactBps: impact, expectedOutRaw };
}
