/** The command line: init, scan, run, status, sell. */
import { CandleClient } from "@candledottv/agent-sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Detector } from "./detect/detector.ts";
import { Engine, acquireLock } from "./engine.ts";
import { Executor } from "./exec/executor.ts";
import { EmbeddedRail, makeSecretStore, resolveEmbedded, resolveWallet, SdkRail, timedFetch, type TradeRail } from "./exec/trader.ts";
import { makeAlerter } from "./alerts.ts";
import { evaluate } from "./filters.ts";
import { Ledger } from "./ledger.ts";
import { makeLogger, type Logger } from "./log.ts";
import { decodeCandleCurve } from "./market/curve.ts";
import { dryPricer } from "./market/reader.ts";
import { addSecret, redact } from "./redact.ts";
import { candleCurve } from "./solana/pda.ts";
import { PUBLIC_RPC, httpRpc, type Rpc } from "./solana/rpc.ts";
import { wsUrlFor } from "./solana/logs-ws.ts";
import { loadStrategy } from "./strategies/load.ts";
import { init, terminalAsk } from "./init.ts";

export const HELP = `candle-launch-bot: buys Candle launches as they appear and exits them by a strategy.

  candle-launch-bot init   [--out bot.json] [--yes] [flags]   write a config (dry mode unless --mode live)
  candle-launch-bot scan   --config bot.json [--for 600]       detect and print what it would buy; never trades
  candle-launch-bot run    --config bot.json [--mode dry|live] run the bot
  candle-launch-bot status --config bot.json                   print status.json
  candle-launch-bot sell   <mint> --config bot.json [--fraction 1]

init flags (all optional; with --yes nothing is asked; defaults shown):
  --mode dry|live (dry)  --payer embedded|linked (embedded)  --key-env <env var with the API key> (CANDLE_API_KEY)
  --wallet <address> (looked up when the key is set)  --api-url <https url>
  --sol 0.01  --max-open 3  --lifetime-sol (10 tickets)  --modes open,exp-custom  --max-age 60  --max-impact 300
  --slippage 500
  --exit hold|tpsl|time|ladder|preGrad (tpsl)  --take-profit 2  --stop-loss 0.5  --trailing <0-1>  --after-sec 900
  --progress 0.8  --fraction 1  --rungs 2:0.3,5:0.3,10:0.2
  --exit-module ./my-exit.js  --exit-params '{"arm":1.5}'   your own strategy file and its params
  --signer keychain|file|env (keychain)  --signer-env <env var with the PEM>  --signer-path <file>
  --signer-pass-env <env var with the file's passphrase>      payer linked only
  --rpc-env <env var with an RPC url>  --rpc-ws-env <env var with a websocket url>
  --webhook <env var with an alert webhook url>  --state-dir <dir> (./state-dry or ./state-live)
  --out bot.json  --force (overwrite)

Controls: create STOP or PAUSE_BUYS in the state folder. Docs: the README.
`;

/** Longest a single Candle API call may take (build, sign relay, submit, reads). */
const SDK_TIMEOUT_MS = 45_000;

function args(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opt[k] = argv[++i];
      else opt[k] = "true";
    } else pos.push(a);
  }
  return { pos, opt };
}

function die(msg: string, code = 2): never {
  process.stderr.write(redact(msg) + "\n");
  process.exit(code);
}

interface Ctx {
  cfg: Config;
  rpc: Rpc;
  wsUrl: string;
  client: CandleClient;
  log: Logger;
}

function context(configPath: string, modeOverride?: string): Ctx {
  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
  if (modeOverride) {
    if (modeOverride !== "dry" && modeOverride !== "live") die("--mode: dry or live");
    if (modeOverride === "live" && cfg.mode !== "live") die('--mode live needs "mode": "live" in the config too (and, for payer linked, its signer)');
    cfg = { ...cfg, mode: modeOverride };
  }
  const apiKey = process.env[cfg.apiKeyEnv];
  addSecret(apiKey);
  const rpcUrl = (cfg.rpcUrlEnv && process.env[cfg.rpcUrlEnv]) || PUBLIC_RPC;
  const wsUrl = (cfg.rpcWsUrlEnv && process.env[cfg.rpcWsUrlEnv]) || wsUrlFor(rpcUrl);
  addSecret(rpcUrl);
  addSecret(wsUrl);
  mkdirSync(cfg.stateDir, { recursive: true });
  const log = makeLogger({ file: join(cfg.stateDir, "events.jsonl") });
  // Every SDK request carries a timeout: the SDK's own requests have none.
  const client = new CandleClient({ apiUrl: cfg.apiUrl, apiKey: apiKey || undefined, privyAppId: cfg.privyAppId, solanaRpcUrl: rpcUrl, fetch: timedFetch(SDK_TIMEOUT_MS) });
  return { cfg, rpc: httpRpc(rpcUrl), wsUrl, client, log };
}

async function buildRail(ctx: Ctx): Promise<{ rail: TradeRail | null; linkedWalletId?: string }> {
  if (ctx.cfg.mode !== "live") return { rail: null };
  const apiKey = process.env[ctx.cfg.apiKeyEnv];
  if (!apiKey) die(`${ctx.cfg.apiKeyEnv} is not set (the Candle API key)`);
  if (ctx.cfg.payer === "embedded") {
    const e = await resolveEmbedded(ctx.cfg, apiKey, timedFetch(SDK_TIMEOUT_MS));
    ctx.log.info("wallet_resolved", { wallet: e.address, payer: "embedded", permission: e.permission });
    return { rail: new EmbeddedRail(new CandleClient({ apiUrl: ctx.cfg.apiUrl, apiKey, fetch: timedFetch(SDK_TIMEOUT_MS) })) };
  }
  const w = await resolveWallet(ctx.cfg, apiKey, timedFetch(SDK_TIMEOUT_MS));
  const store = await makeSecretStore(ctx.cfg, w);
  const client = new CandleClient({ apiUrl: ctx.cfg.apiUrl, apiKey, privyAppId: w.privyAppId, secretStore: store, fetch: timedFetch(SDK_TIMEOUT_MS) });
  if (!(await store.get(w.linkedWalletId))) die(`no signer key for TEE wallet ${ctx.cfg.wallet} in the ${ctx.cfg.signer!.store} store (key ${w.keyPrefix})`);
  ctx.log.info("wallet_resolved", { wallet: ctx.cfg.wallet, linkedWalletId: w.linkedWalletId, keyPrefix: w.keyPrefix, signer: ctx.cfg.signer!.store });
  return { rail: new SdkRail(client, w), linkedWalletId: w.linkedWalletId };
}

async function makeEngine(ctx: Ctx, ledger: Ledger) {
  const strategy = await loadStrategy(ctx.cfg.exit, ctx.cfg.configDir).catch((e) => die(String(e.message)));
  const { rail, linkedWalletId } = await buildRail(ctx);
  const decimals = new Map<string, number>();
  const modes = ledger.modes();
  if ((ctx.cfg.mode === "dry" && modes.live) || (ctx.cfg.mode === "live" && modes.dry))
    die(`${ctx.cfg.stateDir} holds ${modes.live ? "live" : "dry"} positions; use a separate stateDir for ${ctx.cfg.mode} runs`);
  let alerter;
  try {
    alerter = makeAlerter(ctx.cfg.alerts, ledger, ctx.log);
  } catch (e) {
    die(String((e as Error).message));
  }
  const executor = new Executor({
    cfg: ctx.cfg, ledger, rail, linkedWalletId, rpc: ctx.rpc, log: ctx.log, alerter,
    buysPaused: () => existsSync(join(ctx.cfg.stateDir, "PAUSE_BUYS")),
    dry: dryPricer(ctx.rpc, ctx.client, (m) => decimals.get(m) ?? ledger.allPositions().find((p) => p.mint === m)?.decimals ?? 6),
  });
  const detector = new Detector({ rpc: ctx.rpc, wsUrl: ctx.cfg.detect.chain ? ctx.wsUrl : undefined, apiUrl: ctx.cfg.apiUrl, log: ctx.log }, ctx.cfg.detect);
  const engine = new Engine({ cfg: ctx.cfg, ledger, detector, executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter, markets: ctx.client });
  return { engine, detector };
}

async function run(ctx: Ctx): Promise<number> {
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) die(`another process holds ${ctx.cfg.stateDir}/lock`);
  const ledger = new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));
  const { engine, detector } = await makeEngine(ctx, ledger);
  let stopping = false;
  const stop = () => {
    if (!stopping) ctx.log.info("signal_stop");
    stopping = true;
    engine.requestStop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  ctx.log.info("start", { mode: ctx.cfg.mode, payer: ctx.cfg.payer, wallet: ctx.cfg.wallet, strategy: ctx.cfg.exit.strategy, stateDir: ctx.cfg.stateDir, ticketSol: ctx.cfg.buy.sol, maxOpen: ctx.cfg.buy.maxOpen, lifetimeSol: ctx.cfg.buy.lifetimeSol });
  await detector.start();
  try {
    while (await engine.cycle()) await new Promise((r) => setTimeout(r, ctx.cfg.loopMs));
  } finally {
    detector.stop();
    engine.writeStatus();
    ledger.close();
    lock.release();
    ctx.log.info("stopped");
  }
  return 0;
}

async function scan(ctx: Ctx, seconds: number | null): Promise<number> {
  const det = new Detector({ rpc: ctx.rpc, wsUrl: ctx.cfg.detect.chain ? ctx.wsUrl : undefined, apiUrl: ctx.cfg.apiUrl, log: ctx.log }, ctx.cfg.detect);
  await det.start();
  const stopAt = seconds ? Date.now() + seconds * 1000 : Infinity;
  const waiting = new Map<string, number>();
  let quit = false;
  process.on("SIGINT", () => (quit = true));
  process.on("SIGTERM", () => (quit = true));
  const caps = { open: 0, entriesForMint: 0, lifetimeLamports: 0n, paused: false };
  while (!quit && Date.now() < stopAt) {
    for (const l of det.drain()) waiting.set(l.mint, Date.now());
    for (const mint of [...waiting.keys()]) {
      const l = det.get(mint)!;
      let v = evaluate(ctx.cfg, l, null, caps, Date.now());
      if (v.verdict === "wait" && /unknown/.test(v.reason)) {
        try {
          const m: any = await ctx.client.getMarket("solana", mint);
          if (m?.tier && !l.launchMode) l.launchMode = m.tier;
          if (m?.metadata?.name && l.name === undefined) l.name = m.metadata.name;
          if (m?.metadata?.symbol && l.symbol === undefined) l.symbol = m.metadata.symbol;
        } catch { /* not indexed yet */ }
        v = evaluate(ctx.cfg, l, null, caps, Date.now());
      }
      if (v.verdict === "wait" && v.reason === "curve not readable yet") {
        try {
          const r = await ctx.rpc.call<any>("getAccountInfo", [l.curve ?? candleCurve(mint), { encoding: "base64", commitment: "confirmed" }]);
          v = evaluate(ctx.cfg, l, r?.value ? decodeCandleCurve(r.value) : null, caps, Date.now());
        } catch { /* next round */ }
      }
      if (v.verdict === "wait") continue;
      waiting.delete(mint);
      const s = det.sightingsFor(mint);
      ctx.log.info(v.verdict === "buy" ? "scan_would_buy" : "scan_skip", {
        mint, symbol: l.symbol, name: l.name, mode: l.launchMode, creator: l.creator, signer: l.signer, firstSource: l.source,
        apiLatencyMs: s.api?.latencyMs ?? null, chainLatencyMs: s.chain?.latencyMs ?? null, ...(v.verdict === "buy" ? { impactBps: v.impactBps, sol: ctx.cfg.buy.sol } : { reason: v.reason }),
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  det.stop();
  ctx.log.info("scan_done", { api: det.stats.api, chain: det.stats.chain });
  return 0;
}

function status(ctx: Ctx): number {
  const p = join(ctx.cfg.stateDir, "status.json");
  if (!existsSync(p)) die(`no ${p} yet (has the bot run?)`, 1);
  process.stdout.write(readFileSync(p, "utf8") + "\n");
  return 0;
}

async function sell(ctx: Ctx, mint: string, fraction: number): Promise<number> {
  if (!(fraction > 0 && fraction <= 1)) die("--fraction must be in (0, 1]");
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) {
    // The bot is running: hand it the request; it runs the sell through its own executor.
    const dir = join(ctx.cfg.stateDir, "requests");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `sell-${Date.now()}-${process.pid}.json`);
    writeFileSync(f + ".tmp", JSON.stringify({ mint, fraction }));
    renameSync(f + ".tmp", f); // the bot only reads complete files
    process.stdout.write(`the bot is running: request written to ${f}; watch events.jsonl for manual_sell_request\n`);
    return 0;
  }
  const ledger = new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));
  try {
    const { engine } = await makeEngine(ctx, ledger);
    const r = await engine.manualSell(mint, fraction);
    process.stdout.write(r + "\n");
    const m = /^order (\d+)$/.exec(r);
    if (!m) return 1;
    const id = Number(m[1]);
    const exec = (engine as any).d.executor as Executor;
    for (let i = 0; i < 600; i++) {
      await exec.sweep(1, { onlyIds: [id] }); // only this order: never a stale buy queued by an earlier run
      const o = ledger.order(id)!;
      if (!["pending", "inflight"].includes(o.status)) {
        process.stdout.write(`order ${id}: ${o.status}${o.last_error_code ? " (" + o.last_error_code + ")" : ""}\n`);
        return o.status === "filled" ? 0 : 1;
      }
      await new Promise((r) => setTimeout(r, Math.max(500, Math.min(5000, o.next_attempt_at - Date.now()))));
    }
    process.stdout.write(`order ${id} still open; it resumes on the next run\n`);
    return 1;
  } finally {
    ledger.close();
    lock.release();
  }
}

/** The entry point: never lets an error out unredacted (the SDK puts RPC URLs in its messages). */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    return await mainInner(argv);
  } catch (e) {
    process.stderr.write(redact(String((e as Error)?.stack ?? e)) + "\n");
    return 1;
  }
}

async function mainInner(argv: string[]): Promise<number> {
  const { pos, opt } = args(argv);
  const cmd = pos[0];
  if (!cmd || cmd === "help" || opt.help) {
    process.stdout.write(HELP);
    return cmd || opt.help ? 0 : 2;
  }
  if (cmd === "version" || opt.version) {
    process.stdout.write(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version + "\n");
    return 0;
  }
  if (cmd === "init") {
    const interactive = !opt.yes && process.stdin.isTTY === true;
    const t = interactive ? terminalAsk() : null;
    try {
      return await init(opt, { env: process.env, fetch, out: (s) => void process.stdout.write(s), ...(t ? { ask: t.ask } : {}) });
    } catch (e) {
      if (e instanceof ConfigError || (e as Error)?.name === "StrategyConfigError") die(String((e as Error).message));
      throw e;
    } finally {
      t?.close();
    }
  }
  const config = opt.config ?? "bot.json";
  switch (cmd) {
    case "run":
      return run(context(config, opt.mode));
    case "scan":
      return scan(context(config, "dry"), opt.for ? Number(opt.for) : null);
    case "status":
      return status(context(config));
    case "sell":
      if (!pos[1]) die("sell <mint> [--fraction f]");
      return sell(context(config), pos[1], opt.fraction ? Number(opt.fraction) : 1);
    default:
      die(`unknown command ${cmd}`);
  }
}
