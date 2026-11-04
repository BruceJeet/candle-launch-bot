/**
 * logsSubscribe over a websocket (Node's global WebSocket), mentioning one program. Reconnects with backoff;
 * reports up/down so the caller can lean on signature polling while it is down.
 */
export interface LogsEvent {
  signature: string;
  err: unknown;
  logs: string[];
  slot: number;
}

export interface LogsSocket {
  close(): void;
  isUp(): boolean;
}

export function wsUrlFor(httpUrl: string): string {
  return httpUrl.replace(/^http/i, "ws");
}

export function subscribeLogs(
  url: string,
  program: string,
  handlers: { onLogs: (e: LogsEvent) => void; onState?: (up: boolean, why?: string) => void },
  opts: { WebSocketImpl?: typeof WebSocket; maxBackoffMs?: number; pingMs?: number; stallMs?: number; now?: () => number } = {},
): LogsSocket {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  let ws: WebSocket | null = null;
  let up = false;
  let closed = false;
  let failures = 0;
  let ping: ReturnType<typeof setInterval> | null = null;
  const now = opts.now ?? Date.now;
  const stallMs = opts.stallMs ?? 90_000;
  let lastMsg = now();

  const setUp = (v: boolean, why?: string) => {
    if (v !== up) {
      up = v;
      handlers.onState?.(v, why);
    }
  };

  const connect = () => {
    if (closed) return;
    try {
      ws = new WS(url);
    } catch (e) {
      schedule(`connect: ${(e as Error).name}`);
      return;
    }
    ws.onopen = () => {
      ws!.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [program] }, { commitment: "confirmed" }] }));
      if (ping) clearInterval(ping);
      lastMsg = now();
      ping = setInterval(() => {
        // A socket that stays open but stops talking (no notification and no ping reply) is dead: reconnect.
        if (now() - lastMsg > stallMs) {
          setUp(false, "stalled");
          try {
            ws?.close();
          } catch {
            /* closing */
          }
          return;
        }
        try {
          ws?.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "getHealth" }));
        } catch {
          /* the close handler reconnects */
        }
      }, opts.pingMs ?? 30_000);
    };
    ws.onmessage = (m: MessageEvent) => {
      lastMsg = now();
      let msg: any;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer).toString());
      } catch {
        return;
      }
      if (msg.id === 1 && typeof msg.result === "number") {
        failures = 0;
        setUp(true);
        return;
      }
      if (msg.id === 1 && msg.error) {
        setUp(false, "subscribe refused");
        ws?.close();
        return;
      }
      if (msg.method === "logsNotification") {
        const v = msg.params?.result?.value;
        if (v && typeof v.signature === "string") {
          handlers.onLogs({ signature: v.signature, err: v.err ?? null, logs: Array.isArray(v.logs) ? v.logs : [], slot: msg.params?.result?.context?.slot ?? 0 });
        }
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      ping = null;
      setUp(false, "closed");
      schedule("closed");
    };
  };

  const schedule = (why: string) => {
    if (closed) return;
    failures++;
    const delay = Math.min(maxBackoff, 500 * 2 ** Math.min(failures, 8)) * (0.5 + Math.random() / 2);
    setUp(false, why);
    setTimeout(connect, delay);
  };

  connect();
  return {
    close() {
      closed = true;
      if (ping) clearInterval(ping);
      try {
        ws?.close();
      } catch {
        /* closing */
      }
    },
    isUp: () => up,
  };
}
