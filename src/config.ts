/**
 * The one config file. Validated at start; unknown keys are refused at every level so a typo can never be
 * silently ignored. Secrets never live here: the file names the environment variables that hold them.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { asAddress } from "./solana/base58.ts";

export type Mode = "dry" | "live";
export type SignerConfig =
  | { store: "keychain" }
  | { store: "file"; path: string; passphraseEnv: string }
  | { store: "env"; pemEnv: string };

export type Payer = "linked" | "embedded";

export interface Config {
  mode: Mode;
  /** linked: a TEE wallet signed locally with the key signer; embedded: the account's embedded wallet, signed by Candle. */
  payer: Payer;
  apiUrl: string;
  apiKeyEnv: string;
  rpcUrlEnv?: string;
  rpcWsUrlEnv?: string;
  wallet: string;
  linkedWalletId?: string;
  privyWalletId?: string;
  privyAppId?: string;
  signer?: SignerConfig;
  stateDir: string;
  loopMs: number;
  buy: {
    sol: number;
    maxSlippageBps: number;
    maxOpen: number;
    lifetimeSol: number;
    maxPerCoin: number;
    maxPriorityFeeLamports?: number;
  };
  sell: { maxSlippageBps: number; maxPriorityFeeLamports?: number };
  filters: {
    chains: string[];
    launchModes: string[];
    maxAgeSec: number;
    maxImpactBps: number;
    creatorAllow?: string[];
    creatorDeny?: string[];
    nameMatch?: string;
    symbolMatch?: string;
    /** Classify a chain-first launch from its curve account (open / exclusive / exp-*) instead of waiting on Candle's list. */
    inferModeFromCurve: boolean;
  };
  detect: { api: boolean; chain: boolean; apiPollMs: number; chainPollMs: number; apiLimit: number };
  exit: { strategy: string; [param: string]: unknown };
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; maxExitOrders: number; stuckRetryMs: number; builtProbeMs: number; builtHoldMs: number };
  alerts: { command?: string[]; commandEnv?: string[]; webhookEnv?: string; renotifyMs: number; holdAlertMs: number };
  /** The folder of the config file: relative paths in it (stateDir, signer.path, exit.module) resolve here. */
  configDir: string;
}

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function only(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ConfigError(`${where}: unknown key "${k}"`);
}

function num(o: Obj, k: string, where: string, opts: { min?: number; max?: number; int?: boolean; def?: number } = {}): number {
  const v = o[k];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    throw new ConfigError(`${where}.${k}: required`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${where}.${k}: must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new ConfigError(`${where}.${k}: must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`${where}.${k}: must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(`${where}.${k}: must be <= ${opts.max}`);
  return v;
}

function str(o: Obj, k: string, where: string, opts: { def?: string; optional?: boolean; re?: RegExp } = {}): string | undefined {
  const v = o[k];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    if (opts.optional) return undefined;
    throw new ConfigError(`${where}.${k}: required`);
  }
  if (typeof v !== "string" || !v) throw new ConfigError(`${where}.${k}: must be a non-empty string`);
  if (opts.re && !opts.re.test(v)) throw new ConfigError(`${where}.${k}: invalid value`);
  return v;
}

function bool(o: Obj, k: string, where: string, def: boolean): boolean {
  const v = o[k];
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new ConfigError(`${where}.${k}: must be true or false`);
  return v;
}

function strList(o: Obj, k: string, where: string, opts: { def?: string[]; address?: boolean } = {}): string[] | undefined {
  const v = o[k];
  if (v === undefined) return opts.def;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new ConfigError(`${where}.${k}: must be a list of strings`);
  if (opts.address) for (const a of v) if (!asAddress(a)) throw new ConfigError(`${where}.${k}: "${a}" is not an address`);
  return v as string[];
}

function regex(o: Obj, k: string, where: string): string | undefined {
  const v = str(o, k, where, { optional: true });
  if (v === undefined) return v;
  try {
    new RegExp(v, "i");
  } catch {
    throw new ConfigError(`${where}.${k}: not a valid regular expression`);
  }
  return v;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Candle's launch modes (agent-sdk 0.6.14 launch-definition `curve.values`). */
export const LAUNCH_MODES = ["open", "exclusive", "test-open", "test-exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"];
export const KNOWN_CHAINS = ["solana"];

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  only(raw, ["mode", "apiUrl", "apiKeyEnv", "rpcUrlEnv", "rpcWsUrlEnv", "wallet", "linkedWalletId", "privyWalletId", "privyAppId",
    "signer", "payer", "stateDir", "loopMs", "buy", "sell", "filters", "detect", "exit", "retry", "alerts", "$schema", "comment"], "config");

  const mode = str(raw, "mode", "config") as Mode;
  if (mode !== "dry" && mode !== "live") throw new ConfigError('config.mode: must be "dry" or "live"');
  const apiUrl = str(raw, "apiUrl", "config", { def: "https://api.alpha.candle.tv" })!;
  if (!/^https:\/\//.test(apiUrl)) throw new ConfigError("config.apiUrl: must be https://");
  const apiKeyEnv = str(raw, "apiKeyEnv", "config", { re: ENV_NAME })!;
  const rpcUrlEnv = str(raw, "rpcUrlEnv", "config", { optional: true, re: ENV_NAME });
  const rpcWsUrlEnv = str(raw, "rpcWsUrlEnv", "config", { optional: true, re: ENV_NAME });
  const wallet = str(raw, "wallet", "config")!;
  if (!asAddress(wallet)) throw new ConfigError("config.wallet: not a Solana address");
  const linkedWalletId = str(raw, "linkedWalletId", "config", { optional: true, re: /^[A-Za-z0-9_-]{4,128}$/ });
  const privyWalletId = str(raw, "privyWalletId", "config", { optional: true, re: /^[A-Za-z0-9_-]{4,128}$/ });
  const privyAppId = str(raw, "privyAppId", "config", { optional: true, re: /^[A-Za-z0-9]{8,64}$/ });

  let signer: SignerConfig | undefined;
  if (raw.signer !== undefined) {
    const s = raw.signer;
    if (!isObj(s)) throw new ConfigError("config.signer: must be an object");
    const store = str(s, "store", "config.signer");
    if (store === "keychain") {
      only(s, ["store"], "config.signer");
      signer = { store };
    } else if (store === "file") {
      only(s, ["store", "path", "passphraseEnv"], "config.signer");
      signer = { store, path: resolve(baseDir, str(s, "path", "config.signer")!), passphraseEnv: str(s, "passphraseEnv", "config.signer", { re: ENV_NAME })! };
    } else if (store === "env") {
      only(s, ["store", "pemEnv"], "config.signer");
      signer = { store, pemEnv: str(s, "pemEnv", "config.signer", { re: ENV_NAME })! };
    } else throw new ConfigError('config.signer.store: "keychain", "file" or "env"');
  }
  const payer = str(raw, "payer", "config", { def: "linked" }) as Payer;
  if (payer !== "linked" && payer !== "embedded") throw new ConfigError('config.payer: "linked" (TEE wallet, local signer) or "embedded" (Candle signs)');
  if (payer === "embedded" && (signer || privyAppId || linkedWalletId || privyWalletId))
    throw new ConfigError("config: payer \"embedded\" signs on Candle's side; remove signer / privyAppId / linkedWalletId / privyWalletId");
  if (mode === "live" && payer === "linked" && !signer) throw new ConfigError("config.signer: required in live mode with payer \"linked\" (where the wallet's P-256 signer key lives)");

  const stateDir = resolve(baseDir, str(raw, "stateDir", "config", { def: "./state" })!);
  const loopMs = num(raw, "loopMs", "config", { min: 200, max: 60_000, int: true, def: 2000 });

  if (!isObj(raw.buy)) throw new ConfigError("config.buy: required object");
  const b = raw.buy;
  only(b, ["sol", "maxSlippageBps", "maxOpen", "lifetimeSol", "maxPerCoin", "maxPriorityFeeLamports"], "config.buy");
  const buy = {
    sol: num(b, "sol", "config.buy", { min: 0.000001, max: 1000 }),
    maxSlippageBps: num(b, "maxSlippageBps", "config.buy", { min: 0, max: 10_000, int: true }),
    maxOpen: num(b, "maxOpen", "config.buy", { min: 0, int: true }),
    lifetimeSol: num(b, "lifetimeSol", "config.buy", { min: 0 }),
    // One entry per coin: re-entry is not supported (a second position in a coin would share its wallet balance).
    maxPerCoin: num(b, "maxPerCoin", "config.buy", { min: 1, max: 1, int: true, def: 1 }),
    maxPriorityFeeLamports: b.maxPriorityFeeLamports === undefined ? undefined : num(b, "maxPriorityFeeLamports", "config.buy", { min: 0, max: 10_000_000, int: true }),
  };

  const sl = raw.sell === undefined ? {} : raw.sell;
  if (!isObj(sl)) throw new ConfigError("config.sell: must be an object");
  only(sl, ["maxSlippageBps", "maxPriorityFeeLamports"], "config.sell");
  const sell = {
    maxSlippageBps: num(sl, "maxSlippageBps", "config.sell", { min: 0, max: 10_000, int: true, def: Math.max(buy.maxSlippageBps, 1000) }),
    maxPriorityFeeLamports: sl.maxPriorityFeeLamports === undefined ? undefined : num(sl, "maxPriorityFeeLamports", "config.sell", { min: 0, max: 10_000_000, int: true }),
  };

  if (!isObj(raw.filters)) throw new ConfigError("config.filters: required object");
  const f = raw.filters;
  only(f, ["chains", "launchModes", "maxAgeSec", "maxImpactBps", "creatorAllow", "creatorDeny", "nameMatch", "symbolMatch", "inferModeFromCurve"], "config.filters");
  const chains = strList(f, "chains", "config.filters", { def: ["solana"] })!;
  for (const c of chains) if (!KNOWN_CHAINS.includes(c)) throw new ConfigError(`config.filters.chains: "${c}" is not supported yet (${KNOWN_CHAINS.join(", ")})`);
  const launchModes = strList(f, "launchModes", "config.filters");
  if (!launchModes || !launchModes.length) throw new ConfigError("config.filters.launchModes: required, e.g. [\"open\", \"exp-custom\"]");
  for (const m of launchModes) if (!LAUNCH_MODES.includes(m)) throw new ConfigError(`config.filters.launchModes: "${m}" is not a Candle launch mode (${LAUNCH_MODES.join(", ")})`);
  const filters = {
    chains,
    launchModes,
    maxAgeSec: num(f, "maxAgeSec", "config.filters", { min: 1 }),
    maxImpactBps: num(f, "maxImpactBps", "config.filters", { min: 0, max: 10_000 }),
    creatorAllow: strList(f, "creatorAllow", "config.filters", { address: true }),
    creatorDeny: strList(f, "creatorDeny", "config.filters", { address: true }),
    nameMatch: regex(f, "nameMatch", "config.filters"),
    symbolMatch: regex(f, "symbolMatch", "config.filters"),
    inferModeFromCurve: bool(f, "inferModeFromCurve", "config.filters", true),
  };

  const d = raw.detect === undefined ? {} : raw.detect;
  if (!isObj(d)) throw new ConfigError("config.detect: must be an object");
  only(d, ["api", "chain", "apiPollMs", "chainPollMs", "apiLimit"], "config.detect");
  const detect = {
    api: bool(d, "api", "config.detect", true),
    chain: bool(d, "chain", "config.detect", true),
    apiPollMs: num(d, "apiPollMs", "config.detect", { min: 500, int: true, def: 3000 }),
    chainPollMs: num(d, "chainPollMs", "config.detect", { min: 1000, int: true, def: 15_000 }),
    apiLimit: num(d, "apiLimit", "config.detect", { min: 1, max: 200, int: true, def: 20 }),
  };
  if (!detect.api && !detect.chain) throw new ConfigError("config.detect: at least one of api and chain must be on");

  if (!isObj(raw.exit)) throw new ConfigError("config.exit: required object with a strategy name");
  const strategy = str(raw.exit, "strategy", "config.exit", { re: /^[A-Za-z][A-Za-z0-9_-]{0,40}$/ })!;
  const exit = { ...raw.exit, strategy };

  const r = raw.retry === undefined ? {} : raw.retry;
  if (!isObj(r)) throw new ConfigError("config.retry: must be an object");
  only(r, ["maxAttempts", "baseDelayMs", "maxDelayMs", "maxExitOrders", "stuckRetryMs", "builtProbeMs", "builtHoldMs"], "config.retry");
  const retry = {
    maxAttempts: num(r, "maxAttempts", "config.retry", { min: 1, max: 50, int: true, def: 6 }),
    baseDelayMs: num(r, "baseDelayMs", "config.retry", { min: 100, int: true, def: 2000 }),
    maxDelayMs: num(r, "maxDelayMs", "config.retry", { min: 100, int: true, def: 120_000 }),
    maxExitOrders: num(r, "maxExitOrders", "config.retry", { min: 1, max: 20, int: true, def: 3 }),
    stuckRetryMs: num(r, "stuckRetryMs", "config.retry", { min: 60_000, int: true, def: 600_000 }),
    builtProbeMs: num(r, "builtProbeMs", "config.retry", { min: 60_000, int: true, def: 600_000 }),
    builtHoldMs: num(r, "builtHoldMs", "config.retry", { min: 600_000, int: true, def: 21_600_000 }),
  };

  const al = raw.alerts === undefined ? {} : raw.alerts;
  if (!isObj(al)) throw new ConfigError("config.alerts: must be an object");
  only(al, ["command", "commandEnv", "webhookEnv", "renotifyMs", "holdAlertMs"], "config.alerts");
  const command = strList(al, "command", "config.alerts");
  if (command && !command.length) throw new ConfigError("config.alerts.command: an argv list, e.g. [\"/usr/local/bin/notify\", \"bot\"]");
  const alerts = {
    command,
    commandEnv: strList(al, "commandEnv", "config.alerts"),
    webhookEnv: str(al, "webhookEnv", "config.alerts", { optional: true, re: ENV_NAME }),
    renotifyMs: num(al, "renotifyMs", "config.alerts", { min: 60_000, int: true, def: 3_600_000 }),
    holdAlertMs: num(al, "holdAlertMs", "config.alerts", { min: 0, int: true, def: 300_000 }),
  };

  return { mode, payer, apiUrl, apiKeyEnv, rpcUrlEnv, rpcWsUrlEnv, wallet, linkedWalletId, privyWalletId, privyAppId, signer, stateDir, loopMs, buy, sell, filters, detect, exit, retry, alerts, configDir: resolve(baseDir) };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}
