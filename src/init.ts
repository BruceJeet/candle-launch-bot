/**
 * `candle-launch-bot init`: write a validated config. Interactive in a terminal; fully driven by flags with `--yes`
 * (for scripts and agents). The config it writes is in dry mode unless `--mode live` is given.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { LAUNCH_MODES, parseConfig, ConfigError } from "./config.ts";
import { loadStrategy } from "./strategies/load.ts";

const DEFAULT_API = "https://api.alpha.candle.tv";
/** A valid address that is nobody's wallet: lets a dry run start before a wallet is chosen. */
export const PLACEHOLDER_WALLET = "11111111111111111111111111111111";

export interface InitIO {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (s: string) => void;
  /** Ask a question (interactive only). Returns the answer, or the default on an empty line. */
  ask?: (q: string, def: string) => Promise<string>;
}

type Opt = Record<string, string>;

const num = (v: string, what: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`init: ${what} must be a number (got "${v}")`);
  return n;
};

async function embeddedAddress(apiUrl: string, key: string, f: typeof fetch): Promise<string | null> {
  const r = await f(apiUrl + "/api/v1/agent/wallets/embedded", { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return null;
  const b = (await r.json()) as any;
  return typeof b?.wallets?.solana?.address === "string" ? b.wallets.solana.address : null;
}

async function linkedAddresses(apiUrl: string, key: string, f: typeof fetch): Promise<string[]> {
  const r = await f(apiUrl + "/api/v1/agent/wallets/trading", { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return [];
  const b = (await r.json()) as any;
  return (b?.page ?? []).filter((w: any) => w?.chain === "solana" && typeof w?.address === "string").map((w: any) => w.address);
}

/** Exit block from flags: --exit <name> plus that strategy's parameters, or --exit-module <file>. */
function exitFrom(opt: Opt): Record<string, unknown> {
  if (opt["exit-module"]) {
    // Your own file: its params come from --exit-params (JSON), nothing is assumed.
    let params: Record<string, unknown> = {};
    if (opt["exit-params"]) {
      try {
        params = JSON.parse(opt["exit-params"]);
      } catch {
        throw new ConfigError("init: --exit-params must be a JSON object, e.g. '{\"arm\":1.5}'");
      }
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new ConfigError("init: --exit-params must be a JSON object");
    }
    return { ...params, strategy: opt.exit ?? "custom", module: opt["exit-module"] };
  }
  const name = opt.exit ?? "tpsl";
  const e: Record<string, unknown> = { strategy: name };
  const put = (flag: string, key: string) => {
    if (opt[flag] !== undefined) e[key] = num(opt[flag], `--${flag}`);
  };
  if (name === "tpsl") {
    put("take-profit", "takeProfit");
    put("stop-loss", "stopLoss");
    put("trailing", "trailing");
    if (e.takeProfit === undefined && e.stopLoss === undefined && e.trailing === undefined) Object.assign(e, { takeProfit: 2, stopLoss: 0.5 });
  } else if (name === "time") {
    put("after-sec", "afterSec");
    if (e.afterSec === undefined) e.afterSec = 900;
  } else if (name === "preGrad") {
    put("progress", "progress");
    put("fraction", "fraction");
    put("stop-loss", "stopLoss");
    if (e.progress === undefined) e.progress = 0.8;
  } else if (name === "ladder") {
    // --rungs "2:0.3,5:0.3,10:0.2" (at multiple : sell this share of the original size)
    const rungs = (opt.rungs ?? "2:0.3,5:0.3,10:0.2").split(",").map((r) => {
      const [at, sell] = r.split(":");
      return { at: num(at, "--rungs at"), sell: num(sell, "--rungs sell") };
    });
    e.rungs = rungs;
    put("stop-loss", "stopLoss");
  } else if (name !== "hold") {
    throw new ConfigError(`init: --exit "${name}" is not a built-in (hold, tpsl, time, ladder, preGrad); use --exit-module <file> for your own`);
  }
  return e;
}

/** Build the config object from flags (and answers), validate it, and return it with notes for the user. */
export async function buildInitConfig(opt: Opt, io: InitIO): Promise<{ config: Record<string, unknown>; notes: string[] }> {
  const notes: string[] = [];
  const ask = async (key: string, q: string, def: string) => (opt[key] !== undefined ? opt[key] : io.ask ? (await io.ask(q, def)).trim() || def : def);
  const mode = await ask("mode", "Mode (dry = decide and log only, live = trade)", "dry");
  const payer = await ask("payer", "Payer: embedded (Candle signs, API key only) or linked (TEE wallet, local key signer)", "embedded");
  if (payer !== "embedded" && payer !== "linked") throw new ConfigError('init: --payer must be "embedded" or "linked"');
  const apiKeyEnv = await ask("key-env", "Name of the env var holding your Candle API key", "CANDLE_API_KEY");
  const apiUrl = opt["api-url"] ?? DEFAULT_API;

  let wallet = opt.wallet;
  const key = io.env[apiKeyEnv];
  if (!wallet && key) {
    try {
      if (payer === "embedded") {
        const a = await embeddedAddress(apiUrl, key, io.fetch);
        if (a) {
          wallet = await ask("wallet", `Wallet (the key's embedded wallet is ${a})`, a);
          notes.push(`wallet: fetched the key's embedded wallet ${a}`);
        }
      } else {
        const list = await linkedAddresses(apiUrl, key, io.fetch);
        if (list.length) {
          wallet = await ask("wallet", `Wallet (the key's TEE wallets: ${list.join(", ")})`, list[0]);
          notes.push(`wallet: the key has ${list.length} Solana TEE wallet(s)`);
        }
      }
    } catch {
      notes.push("wallet: could not reach Candle to look it up");
    }
  }
  if (!wallet) wallet = await ask("wallet", "Wallet address (Solana)", mode === "dry" ? PLACEHOLDER_WALLET : "");
  if (wallet === PLACEHOLDER_WALLET) {
    if (mode === "live") throw new ConfigError("init: live mode needs your real wallet (--wallet, or set the API key so init can look it up)");
    notes.push("wallet: a placeholder for the dry run; set your wallet before going live");
  }

  const sol = num(await ask("sol", "SOL per launch (ticket)", "0.01"), "--sol");
  const maxOpen = num(await ask("max-open", "Most positions open at once", "3"), "--max-open");
  const lifetimeSol = num(await ask("lifetime-sol", "Most SOL ever spent on buys (lifetime cap)", String(Math.round(sol * 10 * 1e6) / 1e6)), "--lifetime-sol");
  const modes = (await ask("modes", `Launch modes, comma separated (${LAUNCH_MODES.filter((m) => !m.startsWith("test-")).join(", ")})`, "open,exp-custom")).split(",").map((s) => s.trim()).filter(Boolean);
  const maxAgeSec = num(await ask("max-age", "Skip launches older than (seconds)", "60"), "--max-age");
  const maxImpactBps = num(await ask("max-impact", "Skip when your buy moves the price more than (bps)", "300"), "--max-impact");
  const slippage = num(opt.slippage ?? "500", "--slippage");

  if (io.ask && opt.exit === undefined && opt["exit-module"] === undefined) {
    opt = { ...opt, exit: await io.ask("Exit strategy (hold, tpsl, time, ladder, preGrad)", "tpsl") };
    if (opt.exit === "tpsl") opt = { ...opt, "take-profit": await io.ask("Take profit at multiple", "2"), "stop-loss": await io.ask("Stop loss at multiple (0 = none)", "0.5") };
    else if (opt.exit === "time") opt = { ...opt, "after-sec": await io.ask("Sell after (seconds)", "900") };
    else if (opt.exit === "preGrad") opt = { ...opt, progress: await io.ask("Sell at curve progress (0-1)", "0.8") };
    else if (opt.exit === "ladder") opt = { ...opt, rungs: await io.ask("Rungs multiple:fraction, comma separated", "2:0.3,5:0.3,10:0.2") };
  }
  const exit = exitFrom(opt);

  const config: Record<string, unknown> = {
    mode,
    payer,
    apiKeyEnv,
    ...(opt["api-url"] ? { apiUrl } : {}),
    ...(opt["rpc-env"] ? { rpcUrlEnv: opt["rpc-env"] } : {}),
    ...(opt["rpc-ws-env"] ? { rpcWsUrlEnv: opt["rpc-ws-env"] } : {}),
    wallet,
    stateDir: opt["state-dir"] ?? (mode === "live" ? "./state-live" : "./state-dry"),
    buy: { sol, maxSlippageBps: slippage, maxOpen, lifetimeSol },
    filters: { launchModes: modes, maxAgeSec, maxImpactBps },
    exit,
  };
  if (payer === "linked") {
    const store = opt.signer ?? "keychain";
    config.signer = store === "keychain" ? { store } : store === "env" ? { store, pemEnv: opt["signer-env"] ?? "CANDLE_SIGNER_PEM" } : { store: "file", path: opt["signer-path"] ?? "./signer.pem.enc", passphraseEnv: opt["signer-pass-env"] ?? "CANDLE_SIGNER_PASSPHRASE" };
    notes.push(`signer: ${store} (see "Pick a payer" in the README)`);
  }
  if (opt.webhook) config.alerts = { webhookEnv: opt.webhook };
  return { config, notes };
}

/** The `init` command. Returns a process exit code. */
export async function init(opt: Opt, io: InitIO): Promise<number> {
  const out = resolve(opt.out ?? "bot.json");
  if (existsSync(out) && opt.force === undefined) {
    io.out(`${out} exists; pass --force to overwrite\n`);
    return 2;
  }
  const { config, notes } = await buildInitConfig(opt, io);
  // Validate exactly as `run` will: the config and its exit strategy.
  const cfg = parseConfig(config, dirname(out));
  await loadStrategy(cfg.exit, cfg.configDir);
  writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  io.out(`wrote ${out} (mode ${cfg.mode}, payer ${cfg.payer})\n`);
  for (const n of notes) io.out(`  ${n}\n`);
  io.out(`next: candle-launch-bot scan --config ${opt.out ?? "bot.json"} --for 600\n`);
  return 0;
}

/** Terminal prompts for `init` (only when stdin is a TTY and --yes is not given). */
export function terminalAsk(): { ask: (q: string, def: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (q, def) => rl.question(`${q}${def ? ` [${def}]` : ""}: `), close: () => rl.close() };
}
