/**
 * Candle launch-curve and DAMM v2 pool decoding. Pure, no I/O.
 *
 * Candle curve (program 6wXTwJ…dssG, account `Pool`): discriminator 8, authority 32 @8, base_mint @40,
 * quote_mint @72, base_vault @104, quote_vault @136, quote_reserve u64 @168, base_reserve u64 @176,
 * migration_threshold u64 @184, is_migrated bool @192, fee_bps u16 @227, sqrt_price u128 Q64.64 @269,
 * two liquidity segments (target sqrt u128, liquidity u128) @301/@317 and @333/@349. 365 bytes.
 * Spot price (quote per token) = sqrt^2 / 2^128 * 10^(base decimals - quote decimals).
 *
 * DAMM v2 (cp-amm 1.3.4 `Pool`): token_a_mint @168, token_b_mint @200, token_a_vault @232, token_b_vault @264,
 * sqrt_min_price u128 @424, sqrt_price u128 @456, creator @648. Price comes from sqrt_price, never from the
 * vaults (they also hold fees). sqrt_price is token B per token A; the coin may be either side.
 */
import { b58encode } from "../solana/base58.ts";
import { CANDLE_CURVE_PROGRAM, DAMM_V2_PROGRAM } from "../solana/pda.ts";

/** Anchor discriminator of `account:Pool` (shared with pump-amm's Pool). */
const POOL_DISCRIMINATOR = Uint8Array.from([0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc]);
const CURVE_LEN = 365;
const DAMM_MIN_LEN = 680;
const Q128 = 2n ** 128n;

/** A getAccountInfo / getMultipleAccounts value with base64 data. */
export interface AccountValue {
  owner: string;
  data: [string, string] | string[];
  lamports?: number;
}

export class DecodeError extends Error {}

function bytesOf(v: AccountValue | null | undefined, owner: string, minLen: number, what: string): Uint8Array {
  if (!v) throw new DecodeError(`${what}_missing`);
  if (v.owner !== owner) throw new DecodeError(`${what}_owner`);
  const d = v.data;
  if (!Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new DecodeError(`${what}_layout`);
  const b = new Uint8Array(Buffer.from(d[0], "base64"));
  if (b.length < minLen) throw new DecodeError(`${what}_layout`);
  return b;
}

function u64(b: Uint8Array, at: number): bigint {
  return new DataView(b.buffer, b.byteOffset).getBigUint64(at, true);
}
function u128(b: Uint8Array, at: number): bigint {
  return u64(b, at) | (u64(b, at + 8) << 64n);
}
function u16(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint16(at, true);
}
function key(b: Uint8Array, at: number): string {
  return b58encode(b.subarray(at, at + 32));
}

export interface CandleCurve {
  authority: string;
  baseMint: string;
  quoteMint: string;
  quoteReserve: bigint;
  baseReserve: bigint;
  migrationThreshold: bigint;
  migrated: boolean;
  feeBps: number;
  sqrtPrice: bigint;
  segments: Array<{ target: bigint; liquidity: bigint }>;
  /** Byte @225: 1 on `exclusive` launches, 0 on other modes (read from mainnet accounts; not in the IDL). */
  flag225: number;
  /** u128 @285: the same on every curve of one preset (likely the start sqrt price; not in the IDL). */
  presetSqrt: bigint;
}

export function decodeCandleCurve(v: AccountValue | null | undefined): CandleCurve {
  const b = bytesOf(v, CANDLE_CURVE_PROGRAM, CURVE_LEN, "curve");
  for (let i = 0; i < 8; i++) if (b[i] !== POOL_DISCRIMINATOR[i]) throw new DecodeError("curve_layout");
  return {
    authority: key(b, 8),
    baseMint: key(b, 40),
    quoteMint: key(b, 72),
    quoteReserve: u64(b, 168),
    baseReserve: u64(b, 176),
    migrationThreshold: u64(b, 184),
    migrated: b[192] !== 0,
    feeBps: u16(b, 227),
    sqrtPrice: u128(b, 269),
    segments: [
      { target: u128(b, 301), liquidity: u128(b, 317) },
      { target: u128(b, 333), liquidity: u128(b, 349) },
    ],
    flag225: b[225],
    presetSqrt: u128(b, 285),
  };
}

export type CurveClass = "open";

/**
 * The SOL `open` preset, as read from SOL-quoted open launches on mainnet: migration threshold, fee, both liquidity
 * segments, and the preset sqrt at @285.
 */
export const OPEN_PRESET = {
  migrationThreshold: 80_000_000_000n,
  feeBps: 100,
  flag225: 0,
  presetSqrt: 91_862_415_507_570_671n,
  segments: [
    { target: 218_935_341_325_369_486n, liquidity: 117_494_894_994_231_126_086_956_521_739_130n },
    { target: 521_787_756_357_285_822n, liquidity: 40_600_059_905_644_895_696_950_032_446_463n },
  ],
};

/**
 * Launch mode from the curve account alone, for a launch seen on chain before Candle's list has it: `open` only on a
 * full match of the open preset. An exp-custom curve can take any threshold, so nothing short of the whole preset
 * proves open; anything else (exclusive and every exp mode included) returns null and waits for Candle's `tier`.
 */
export function curveClass(c: CandleCurve): CurveClass | null {
  const p = OPEN_PRESET;
  const same = c.migrationThreshold === p.migrationThreshold && c.feeBps === p.feeBps && c.flag225 === p.flag225 && c.presetSqrt === p.presetSqrt &&
    c.segments.length === 2 && c.segments.every((s, i) => s.target === p.segments[i].target && s.liquidity === p.segments[i].liquidity);
  return same ? "open" : null;
}

/** Quote per whole token from a Q64.64 sqrt price. */
export function priceFromSqrt(sqrt: bigint, decimals: number, quoteDecimals = 9): number {
  return (Number(sqrt * sqrt) / Number(Q128)) * 10 ** (decimals - quoteDecimals);
}

/** Graduation progress 0..1: quote_reserve / migration_threshold, 1 once migrated. */
export function curveProgress(c: CandleCurve): number {
  if (c.migrated) return 1;
  if (c.migrationThreshold === 0n) throw new DecodeError("curve_layout");
  return Math.min(1, Number(c.quoteReserve) / Number(c.migrationThreshold));
}

export interface BuyImpact {
  /** Average price over spot, minus 1 (after the curve fee is taken from the input). */
  impact: number;
  impactBps: number;
  /** The curve's own fee, bps of the input. */
  feeBps: number;
  /** Tokens out (raw) the curve math gives for this size, before slippage. */
  expectedOutRaw: bigint;
}

/**
 * Price impact of buying `lamports` of quote on the curve now. Constant-liquidity segments in sqrt price:
 * delta quote = L * delta s / 2^128 (Q64.64), across segments as needed. Throws `buy_past_graduation`
 * when the buy would complete the curve (the remainder would fill on another venue at another price).
 */
export function buyImpact(c: CandleCurve, lamports: bigint): BuyImpact {
  if (c.migrated) throw new DecodeError("curve_complete");
  let left = (lamports * BigInt(10_000 - c.feeBps)) / 10_000n;
  if (c.quoteReserve + left >= c.migrationThreshold) throw new DecodeError("buy_past_graduation");
  const s0 = c.sqrtPrice;
  if (s0 === 0n) throw new DecodeError("curve_reserves");
  let s = s0;
  let out = 0n;
  for (const { target, liquidity } of c.segments) {
    if (left <= 0n || liquidity === 0n || s >= target) continue;
    const room = (liquidity * (target - s)) / Q128;
    const step = left < room ? left : room;
    const s1 = s + (step * Q128) / liquidity;
    // With quote = L * ds / 2^128, the matching base side is L * (s1 - s) / (s * s1).
    out += (liquidity * (s1 - s)) / (s * s1);
    s = s1;
    left -= step;
  }
  if (left > 0n) throw new DecodeError("buy_past_graduation");
  const impact = Number(s) / Number(s0) - 1;
  return { impact, impactBps: Math.round(impact * 10_000), feeBps: c.feeBps, expectedOutRaw: out };
}

export interface DammPool {
  tokenA: string;
  tokenB: string;
  sqrtMinPrice: bigint;
  sqrtPrice: bigint;
  creator: string;
}

export function decodeDamm(v: AccountValue | null | undefined): DammPool {
  const b = bytesOf(v, DAMM_V2_PROGRAM, DAMM_MIN_LEN, "pool");
  return {
    tokenA: key(b, 168),
    tokenB: key(b, 200),
    sqrtMinPrice: u128(b, 424),
    sqrtPrice: u128(b, 456),
    creator: key(b, 648),
  };
}

/** Quote per whole coin from a DAMM v2 pool, whichever side the coin is on. */
export function dammPrice(p: DammPool, mint: string, decimals: number, quoteDecimals = 9): number {
  if (p.sqrtPrice === 0n) throw new DecodeError("pool_reserves");
  if (p.tokenA === mint) return priceFromSqrt(p.sqrtPrice, decimals, quoteDecimals);
  if (p.tokenB === mint) {
    const ab = priceFromSqrt(p.sqrtPrice, quoteDecimals, decimals); // quote per coin inverted
    return 1 / ab;
  }
  throw new DecodeError("pool_mismatch");
}

/** How far a DAMM v2 pool sits above its floor (sqrt_min_price): price/floor - 1. At ~0 nothing can be sold. */
export function dammRoomAboveFloor(p: DammPool): number | null {
  if (p.sqrtMinPrice === 0n) return null;
  const r = Number(p.sqrtPrice) / Number(p.sqrtMinPrice);
  return r * r - 1;
}
