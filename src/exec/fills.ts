/**
 * Book fills from the transaction, never from a quote.
 *  - token delta: the owner's post minus pre token balance for the mint (all of its accounts)
 *  - quote delta: the owner's native SOL change, plus any WSOL token change, with the network fee (when the
 *    owner paid it) and token-account rent (created or returned) separated out
 */
export interface Fill {
  signature: string;
  slot: number | null;
  blockTimeMs: number | null;
  /** Token raw units the owner gained (buy, > 0) or gave up (sell, < 0). */
  tokenDeltaRaw: bigint;
  /** Lamports the owner's SOL (native + WSOL) changed by, all-in (includes fee and rent). */
  solDeltaLamports: bigint;
  /** Network fee the owner paid as fee payer (0 when someone else paid). */
  networkFeeLamports: bigint;
  /** Lamports moved into (> 0) or back out of (< 0) the owner's token accounts for this mint: rent, not price. */
  rentLamports: bigint;
  /** Swap leg in lamports, net of the network fee and rent: what the trade itself cost (buy, < 0) or paid (sell, > 0). */
  swapLamports: bigint;
  err: unknown;
}

function keysOf(tx: any): string[] {
  const keys: string[] = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k?.pubkey));
  const loaded = tx?.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
  return keys;
}

const WSOL = "So11111111111111111111111111111111111111112";

function tokenSum(rows: any[] | undefined, owner: string, mint: string): bigint {
  let s = 0n;
  for (const r of rows ?? []) if (r?.owner === owner && r?.mint === mint) s += BigInt(r?.uiTokenAmount?.amount ?? "0");
  return s;
}

export class FillError extends Error {}

export function fillFromTx(tx: any, owner: string, mint: string): Fill {
  if (!tx?.meta) throw new FillError("transaction has no meta");
  const meta = tx.meta;
  const keys = keysOf(tx);
  const i = keys.indexOf(owner);
  const pre = meta.preBalances ?? [];
  const post = meta.postBalances ?? [];
  const native = i >= 0 ? BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0) : 0n;
  const wsol = tokenSum(meta.postTokenBalances, owner, WSOL) - tokenSum(meta.preTokenBalances, owner, WSOL);
  const tokenDelta = tokenSum(meta.postTokenBalances, owner, mint) - tokenSum(meta.preTokenBalances, owner, mint);
  const fee = i === 0 ? BigInt(meta.fee ?? 0) : 0n;

  // Rent: lamport change of the owner's token accounts for this mint (an account opened on a buy, closed on a sell).
  const accts = new Set<number>();
  for (const r of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) if (r?.owner === owner && r?.mint === mint) accts.add(r.accountIndex);
  let rent = 0n;
  for (const a of accts) rent += BigInt(post[a] ?? 0) - BigInt(pre[a] ?? 0);
  // An account closed in this tx drops out of postTokenBalances but keeps its index: covered by the set above.

  const solDelta = native + wsol;
  // The owner's SOL went to: the swap, the fee, and rent into its token account. Add the last two back.
  const swap = solDelta + fee + rent;
  return {
    signature: tx.transaction?.signatures?.[0] ?? "",
    slot: typeof tx.slot === "number" ? tx.slot : null,
    blockTimeMs: typeof tx.blockTime === "number" ? tx.blockTime * 1000 : null,
    tokenDeltaRaw: tokenDelta,
    solDeltaLamports: solDelta,
    networkFeeLamports: fee,
    rentLamports: rent,
    swapLamports: swap,
    err: meta.err ?? null,
  };
}
