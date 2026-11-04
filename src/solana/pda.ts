import { createHash } from "node:crypto";
import { b58decode, b58encode } from "./base58.ts";

export const WSOL = "So11111111111111111111111111111111111111112";
/** Candle's launch curve program (gated bonding curve). */
export const CANDLE_CURVE_PROGRAM = "6wXTwJwdtA5RhNu6VyYnBzrV51TbsMpTbo5kZv2zdssG";
/** Meteora DAMM v2 (cp-amm): where a graduated Candle coin's pool lives. */
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

const P = 2n ** 255n - 19n;
const D = (-121665n * modpow(121666n, P - 2n, P)) % P;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** True when 32 bytes decompress to an ed25519 point: the test Solana's PDA search uses. */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = (y & ((1n << 255n) - 1n)) % P;
  const u = mod(y * y - 1n, P);
  const v = mod(D * y * y + 1n, P);
  if (u === 0n) return true;
  const x2 = mod(u * modpow(v, P - 2n, P), P);
  return x2 === 0n || modpow(x2, (P - 1n) / 2n, P) === 1n;
}

export function findPda(seeds: Uint8Array[], program: string): string {
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(prog);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const out = new Uint8Array(h.digest());
    if (!onCurve(out)) return b58encode(out);
  }
  throw new Error("no viable PDA bump");
}

const enc = (s: string) => new TextEncoder().encode(s);

/** The Candle launch curve account for a mint: PDA("pool", mint, quote). */
export function candleCurve(mint: string, quote = WSOL): string {
  return findPda([enc("pool"), b58decode(mint), b58decode(quote)], CANDLE_CURVE_PROGRAM);
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The DAMM v2 pool Candle's keeper creates at graduation: PDA("cpool", max(mint, quote), min(mint, quote)). */
export function dammPool(mint: string, quote = WSOL): string {
  const a = b58decode(mint);
  const b = b58decode(quote);
  const [hi, lo] = cmp(a, b) > 0 ? [a, b] : [b, a];
  return findPda([enc("cpool"), hi, lo], DAMM_V2_PROGRAM);
}
