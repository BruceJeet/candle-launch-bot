const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  let lead = 0;
  while (lead < bytes.length && bytes[lead] === 0) lead++;
  return "1".repeat(lead) + s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = INDEX.get(c);
    if (i === undefined) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let lead = 0;
  while (lead < s.length && s[lead] === "1") lead++;
  return Uint8Array.from([...new Array(lead).fill(0), ...body]);
}

/** A 32-byte Solana address in base58, or null. */
export function asAddress(s: unknown): string | null {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return null;
  try {
    return b58decode(s).length === 32 ? s : null;
  } catch {
    return null;
  }
}
