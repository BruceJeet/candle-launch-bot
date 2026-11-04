/**
 * Alerts that leave the process. Every alert is deduped in the ledger under a key that carries the worsening
 * dimension (attempt bucket, terminal state); a key is announced when first seen and again after `renotifyMs`
 * while it keeps recurring. Conditions that need a human (exit_stuck, a fill that cannot be read) are re-raised by
 * the engine every cycle, so they re-announce on that schedule until cleared.
 *
 * Sinks (both optional, both redacted, both bounded by a timeout, neither can stop the bot):
 *  - command: an argv list run without a shell; the alert is JSON on its stdin, ALERT_KEY / ALERT_MESSAGE in env
 *  - webhook: POST JSON {key, message, at} to the URL held in the env var named by webhookEnv
 */
import { spawn } from "node:child_process";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { addSecret, redact } from "./redact.ts";

export interface AlertConfig {
  command?: string[];
  /** Env var names passed to the command besides PATH, ALERT_KEY, ALERT_MESSAGE (nothing else is inherited). */
  commandEnv?: string[];
  webhookEnv?: string;
  renotifyMs: number;
}

export type AlertSink = (a: { key: string; message: string; at: string }) => Promise<void>;

export function commandSink(argv: string[], timeoutMs = 10_000, passEnv: string[] = [], env: NodeJS.ProcessEnv = process.env): AlertSink {
  return (a) =>
    new Promise((resolve) => {
      try {
        // A minimal environment: the API key, signer, RPC URL and webhook never reach the alert command.
        const childEnv: Record<string, string> = { PATH: env.PATH ?? "/usr/bin:/bin", ALERT_KEY: a.key, ALERT_MESSAGE: a.message };
        for (const n of passEnv) if (env[n] !== undefined) childEnv[n] = env[n]!;
        const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "ignore"], env: childEnv, timeout: timeoutMs });
        child.on("error", () => resolve());
        child.on("exit", () => resolve());
        child.stdin.on("error", () => undefined);
        child.stdin.end(JSON.stringify(a) + "\n");
      } catch {
        resolve();
      }
    });
}

export function webhookSink(url: string, f: typeof fetch = fetch, timeoutMs = 10_000): AlertSink {
  addSecret(url);
  return async (a) => {
    try {
      await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      /* a dead webhook never stops the bot; the ledger and the log keep the alert */
    }
  };
}

export class Alerter {
  private ledger: Ledger;
  private log: Logger;
  private sinks: AlertSink[];
  private now: () => number;
  readonly renotifyMs: number;
  sent = 0;

  constructor(ledger: Ledger, log: Logger, sinks: AlertSink[], renotifyMs: number, now: () => number = Date.now) {
    this.ledger = ledger;
    this.log = log;
    this.sinks = sinks;
    this.renotifyMs = renotifyMs;
    this.now = now;
  }

  /** Record an alert; announce it (log + sinks) when it is new or its renotify time has come. */
  raise(key: string, message: string, fields: Record<string, unknown> = {}): boolean {
    const due = this.ledger.alert(key, message, this.now(), this.renotifyMs);
    if (!due) return false;
    const msg = redact(message);
    this.log.warn("alert", { key, message: msg, ...fields });
    const a = { key: redact(key), message: msg, at: new Date(this.now()).toISOString() };
    this.sent++;
    for (const s of this.sinks) void s(a).catch(() => undefined);
    return true;
  }
}

export function makeAlerter(cfg: AlertConfig, ledger: Ledger, log: Logger, env: NodeJS.ProcessEnv = process.env, now?: () => number): Alerter {
  const sinks: AlertSink[] = [];
  if (cfg.command?.length) sinks.push(commandSink(cfg.command, 10_000, cfg.commandEnv ?? [], env));
  if (cfg.webhookEnv) {
    const url = env[cfg.webhookEnv];
    if (!url) throw new Error(`alerts.webhookEnv: ${cfg.webhookEnv} is not set`);
    sinks.push(webhookSink(url));
  }
  return new Alerter(ledger, log, sinks, cfg.renotifyMs, now);
}
