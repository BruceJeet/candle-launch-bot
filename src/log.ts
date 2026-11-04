import { appendFileSync } from "node:fs";
import { redact } from "./redact.ts";

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: Level, event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function json(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

/** JSON lines to stdout and (optionally) a file; every line is redacted before it leaves the process. */
export function makeLogger(opts: { file?: string; level?: Level; stdout?: boolean; now?: () => number } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const now = opts.now ?? Date.now;
  const log = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    const line = redact(json({ t: new Date(now()).toISOString(), level, event, ...fields }));
    if (opts.stdout !== false) process.stdout.write(line + "\n");
    if (opts.file) {
      try {
        appendFileSync(opts.file, line + "\n");
      } catch {
        /* the log file must never stop the bot */
      }
    }
  };
  return {
    log,
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
  };
}

/** A logger that keeps lines in memory (tests). */
export function memoryLogger(): Logger & { lines: Array<{ level: Level; event: string; [k: string]: unknown }> } {
  const lines: Array<{ level: Level; event: string; [k: string]: unknown }> = [];
  const log = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    lines.push(JSON.parse(redact(json({ level, event, ...fields }))));
  };
  return { lines, log, info: (e, f) => log("info", e, f), warn: (e, f) => log("warn", e, f), error: (e, f) => log("error", e, f) };
}
