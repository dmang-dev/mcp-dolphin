// dolphin.ts — Node TCP client for the in-Dolphin Python bridge
// ──────────────────────────────────────────────────────────────
//
// The Python bridge (bridge/mcp_bridge.py, loaded into Felk's Dolphin
// fork via the Scripting panel) listens on 127.0.0.1:55355 and accepts
// newline-delimited JSON requests. This client opens a TCP socket to
// it, ships requests, and correlates ticketed replies back to the
// originating Promise.
//
// Wire format:
//   request  → {"id": <int>, "method": "<group.method>", "params": [...]}\n
//   response ← {"id": <int>, "result": <value>}\n
//              {"id": <int>, "error": "<message>"}\n
//
// Reconnect strategy (learned the hard way on mcp-ppsspp v0.1.2/v0.1.4):
//   The connect/ready promise is memoised so concurrent ensureConnected()
//   calls share one underlying attempt. The close handler clears the
//   memoised promise so the NEXT call actually retries instead of
//   short-circuiting on a stale resolved promise pointing at a dead
//   socket. This means the user can stop/restart Dolphin (or just the
//   bridge script) without restarting the MCP server.

import net from "node:net";

interface PendingCmd {
  id: number;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface DolphinOptions {
  /** Bridge host (TCP loopback). Default 127.0.0.1. */
  host?: string;
  /** Bridge port. Default 55355 — matches bridge/mcp_bridge.py. */
  port?: number;
  /** Per-call timeout (ms). Default 10000. */
  timeoutMs?: number;
}

export class DolphinClient {
  private sock: net.Socket | null = null;
  private inflight = new Map<number, PendingCmd>();
  private nextId = 1;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  /** True once the socket is connected and ready for RPC. */
  private ready = false;
  /** Connection lifecycle promise — resolves once ready is true. */
  private readyPromise: Promise<void> | null = null;
  /** Newline-buffer for partial reads across packet boundaries. */
  private rxBuffer = "";

  constructor(opts: DolphinOptions = {}) {
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 55355;
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  describeTarget(): string {
    return `tcp ${this.host}:${this.port}`;
  }

  isConnected(): boolean {
    return this.sock !== null && !this.sock.destroyed && this.ready;
  }

  /**
   * Connect to the Dolphin Python bridge. Resolves when the socket is
   * open and ready for RPC. Rejects on TCP connect failure.
   */
  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const sock = new net.Socket();
      this.sock = sock;

      const onConnectError = (err: Error) => {
        this.readyPromise = null;
        this.sock = null;
        reject(new Error(`Dolphin bridge connect failed: ${err.message}`));
      };
      sock.once("error", onConnectError);

      sock.connect(this.port, this.host, () => {
        sock.off("error", onConnectError);
        this.ready = true;
        process.stderr.write(`[mcp-dolphin] connected to ${this.describeTarget()}\n`);

        sock.on("error", (err) => {
          process.stderr.write(`[mcp-dolphin] socket error: ${err.message}\n`);
        });
        sock.on("close", (hadError) => {
          process.stderr.write(`[mcp-dolphin] socket closed (hadError=${hadError})\n`);
          this.ready = false;
          this.sock = null;
          // CRITICAL: clear readyPromise. Without this, start() would
          // short-circuit on the cached resolved promise next time and
          // call() would deref a null socket. (Same bug shape as
          // mcp-ppsspp v0.1.3 → fixed in v0.1.4.)
          this.readyPromise = null;
          for (const p of this.inflight.values()) {
            p.reject(new Error("Dolphin bridge socket closed mid-request"));
          }
          this.inflight.clear();
        });
        sock.on("data", (chunk) => this.onData(chunk));
        resolve();
      });
    });
    return this.readyPromise;
  }

  stop(): void {
    this.sock?.destroy();
    this.sock = null;
    this.ready = false;
    this.readyPromise = null;
  }

  private onData(chunk: Buffer): void {
    this.rxBuffer += chunk.toString("utf8");
    let nl = this.rxBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.rxBuffer.slice(0, nl);
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      this.onLine(line);
      nl = this.rxBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch (err) {
      process.stderr.write(`[mcp-dolphin] bad JSON from bridge: ${(err as Error).message}\n`);
      return;
    }
    const id = msg.id;
    if (typeof id !== "number") {
      // Bridge currently sends no unsolicited messages; this is unexpected
      // but we ignore rather than blow up.
      process.stderr.write(`[mcp-dolphin] message without id from bridge: ${line.slice(0, 200)}\n`);
      return;
    }
    const pending = this.inflight.get(id);
    if (!pending) {
      process.stderr.write(`[mcp-dolphin] unknown id from bridge: ${id}\n`);
      return;
    }
    this.inflight.delete(id);
    if (msg.error !== undefined) {
      pending.reject(new Error(`Dolphin bridge error: ${msg.error}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Lazy connection guard used by call(). If the socket isn't currently
   * open, attempts to (re)connect, throwing a tool-call-shaped error
   * pointing at the right fix on failure.
   */
  private async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    try {
      await this.start();
    } catch (err) {
      throw new Error(
        `Dolphin bridge not reachable at ${this.describeTarget()}: ${(err as Error).message}.  ` +
        `Make sure Dolphin (Felk's fork) is running with mcp_bridge.py loaded via Scripting → Add New Script. ` +
        `Print the bridge script with: npx mcp-dolphin --print-bridge > mcp_bridge.py`,
      );
    }
  }

  /**
   * Send an RPC request and wait for the ticketed response. `method` is
   * one of the bridge handlers (e.g. "memory.read_u32"). `params` is the
   * positional argument list — refer to bridge/mcp_bridge.py.
   */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    await this.ensureConnected();
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const pending: PendingCmd = {
        id,
        resolve: (r) => resolve(r as T),
        reject,
      };

      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(
          `Dolphin bridge call "${method}" timed out (${this.timeoutMs}ms) — ` +
          `is the mcp_bridge.py script still loaded in Dolphin's Scripting panel?`,
        ));
      }, this.timeoutMs);
      const origResolve = pending.resolve, origReject = pending.reject;
      pending.resolve = (r) => { clearTimeout(timer); origResolve(r); };
      pending.reject  = (e) => { clearTimeout(timer); origReject(e); };

      this.inflight.set(id, pending);
      const msg = JSON.stringify({ id, method, params });
      if (process.env.MCP_DOLPHIN_DEBUG) {
        process.stderr.write(`[trace] TX: ${msg}\n`);
      }
      this.sock!.write(msg + "\n");
    });
  }
}
