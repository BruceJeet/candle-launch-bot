/**
 * Secret redaction for every outbound path (logs, ledger error rows, status.json, stdout).
 *
 * Two passes, value first:
 *  1. By value: the literal value of every environment variable whose NAME looks like a secret, plus any
 *     value registered explicitly (the API key, an RPC URL with a key in it). Values shorter than 8 chars are
 *     skipped so ordinary words are never scrubbed. For a URL-valued variable only its query string and
 *     userinfo are treated as secret, so the bare host still reads.
 *  2. By pattern: bearer tokens, keyed query strings, webhook URLs, vendor-prefixed keys, PEM blocks.
 * Callers truncate AFTER redacting, never before (a cut can leave a key's head behind as plain text).
 */

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD|WEBHOOK|CREDENTIAL|AUTH|PRIVATE|PEM|RPC/i;
const MIN_LEN = 8;

const extra = new Set<string>();

/** Register a value that must never appear in output (e.g. the resolved API key or RPC URL). */
export function addSecret(value: string | undefined | null): void {
  if (!value || value.length < MIN_LEN) return;
  for (const v of secretParts(value)) extra.add(v);
}

function secretParts(value: string): string[] {
  if (/^(https?|wss?):\/\//i.test(value)) {
    const out: string[] = [];
    try {
      const u = new URL(value);
      if (u.search.length > 1) out.push(u.search.slice(1));
      for (const [, v] of u.searchParams) if (v.length >= MIN_LEN) out.push(v);
      if (u.password) out.push(u.password);
      if (u.username && u.username.length >= MIN_LEN) out.push(u.username);
      // Path segments that look like keys (Helius/QuickNode style /<key>/)
      for (const seg of u.pathname.split("/")) if (seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg)) out.push(seg);
    } catch {
      /* not a URL after all */
    }
    return out;
  }
  return [value];
}

function envSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_LEN || !SECRET_NAME.test(name)) continue;
    out.push(...secretParts(value));
  }
  return out;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_PEM]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\bcndl_(live|test)_[A-Za-z0-9_-]{6,}/g, "cndl_$1_[REDACTED]"],
  [/([?&](api[-_]?key|key|token|access[-_]?token|secret|auth|signature|sig)=)[^&\s"'#]+/gi, "$1[REDACTED]"],
  [/https:\/\/(discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[^\s"']+/gi, "https://$1/[REDACTED]"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_[REDACTED]"],
  [/\bx-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi, "x-api-key: [REDACTED]"],
];

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let s = text;
  const values = [...envSecrets(env), ...extra].sort((a, b) => b.length - a.length);
  for (const v of values) if (v && s.includes(v)) s = s.split(v).join("[REDACTED]");
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** Redact, then truncate: the only safe order. */
export function redactTruncate(text: string, max: number, env: NodeJS.ProcessEnv = process.env): string {
  const s = redact(text, env);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Deep-redact any JSON-able value (strings inside objects and arrays). */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return redact(value, env) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, env)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, env);
    return out as T;
  }
  return value;
}

/** Stringify an error with code/data, redacted. Never just the (truncated, maybe credential-bearing) message. */
export function errorJson(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return redact(
    JSON.stringify(err, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) {
        const o: Record<string, unknown> = { name: v.name, message: v.message };
        for (const k of Object.getOwnPropertyNames(v)) if (k !== "stack") o[k] = (v as any)[k];
        if ((v as any).cause) o.cause = (v as any).cause;
        return o;
      }
      return v;
    }),
    env,
  );
}
