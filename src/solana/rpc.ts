/** Minimal Solana JSON-RPC over fetch, with a timeout and structured errors (code + data kept, URL never in the message). */
import type { AccountValue } from "../market/curve.ts";

export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export class RpcError extends Error {
  code: number | string;
  data: unknown;
  constructor(message: string, code: number | string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export interface Rpc {
  call<T = any>(method: string, params: unknown[]): Promise<T>;
}

export function httpRpc(url: string, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Rpc {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let id = 0;
  return {
    async call(method, params) {
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new RpcError(`rpc ${method}: ${(e as Error).name}`, "NETWORK");
      }
      if (!res.ok) throw new RpcError(`rpc ${method}: HTTP ${res.status}`, `HTTP_${res.status}`);
      const body = (await res.json()) as any;
      if (body.error) throw new RpcError(`rpc ${method}: ${body.error.message ?? "error"}`, body.error.code ?? "RPC", body.error.data);
      return body.result;
    },
  };
}

export async function getAccounts(rpc: Rpc, keys: string[]): Promise<Array<AccountValue | null>> {
  const out: Array<AccountValue | null> = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc.call<{ value: Array<AccountValue | null> }>("getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }]);
    if (!r || !Array.isArray(r.value) || r.value.length !== Math.min(100, keys.length - i)) throw new RpcError("getMultipleAccounts: bad response length", "BAD_RESPONSE");
    out.push(...r.value);
  }
  return out;
}

export async function getTransaction(rpc: Rpc, signature: string): Promise<any | null> {
  return rpc.call("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
}

/** Sum of every token account the owner holds for the mint (raw units), or null when the read fails. */
export async function tokenBalance(rpc: Rpc, owner: string, mint: string): Promise<bigint | null> {
  try {
    const r = await rpc.call<any>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!r || !Array.isArray(r.value)) return null;
    let sum = 0n;
    for (const a of r.value) {
      const amt = a?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amt !== "string" || !/^\d+$/.test(amt)) return null;
      sum += BigInt(amt);
    }
    return sum;
  } catch {
    return null;
  }
}

/** The owner's token accounts for a mint (addresses), or null when the read fails. */
export async function tokenAccounts(rpc: Rpc, owner: string, mint: string): Promise<string[] | null> {
  try {
    const r = await rpc.call<any>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!r || !Array.isArray(r.value)) return null;
    return r.value.map((a: any) => a?.pubkey).filter((x: unknown) => typeof x === "string");
  } catch {
    return null;
  }
}

export interface SigStatus {
  found: boolean;
  err: unknown;
  confirmationStatus?: string;
}

export async function signatureStatus(rpc: Rpc, signature: string): Promise<SigStatus> {
  const r = await rpc.call<any>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const v = r?.value?.[0];
  if (!v) return { found: false, err: null };
  return { found: true, err: v.err ?? null, confirmationStatus: v.confirmationStatus };
}

/** Whether a recent blockhash can still be used (the chain's block height against its lastValidBlockHeight). */
export async function blockhashValid(rpc: Rpc, blockhash: string): Promise<boolean> {
  const r = await rpc.call<any>("isBlockhashValid", [blockhash, { commitment: "processed" }]);
  if (typeof r?.value !== "boolean") throw new RpcError("isBlockhashValid: bad response", "BAD_RESPONSE");
  return r.value;
}
