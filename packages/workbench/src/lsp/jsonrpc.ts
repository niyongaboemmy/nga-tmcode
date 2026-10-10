/**
 * JSON-RPC 2.0 as the Language Server Protocol uses it: requests with ids
 * (cancellable through `$/cancelRequest`), notifications, and requests the
 * server sends to the client. Framing is the host's job (Rust adds the
 * `Content-Length` header); this side moves JSON text.
 */

export interface RpcTransport {
  send(text: string): void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** LSP's RequestCancelled / ContentModified: a result nobody needs any more, not a failure. */
export const isCancellation = (e: unknown) => e instanceof RpcError && (e.code === -32800 || e.code === -32801);

type Handler = (params: unknown) => unknown;

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

export class RpcConnection {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private requestHandlers = new Map<string, Handler>();
  private notificationHandlers = new Map<string, Handler>();
  private closed = false;
  /** Called for messages nobody handles (logged by the client). */
  onUnhandled: (method: string) => void = () => {};

  constructor(private transport: RpcTransport) {}

  request<T>(method: string, params: unknown, token?: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): unknown }): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError("The language server has stopped.", -32099));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      token?.onCancellationRequested(() => {
        if (!this.pending.has(id)) return;
        this.transport.send(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }));
      });
    });
  }

  notify(method: string, params: unknown) {
    if (this.closed) return;
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onRequest(method: string, handler: Handler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: Handler) {
    this.notificationHandlers.set(method, handler);
  }

  /** One message from the server (JSON text). */
  receive(text: string) {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      const h = this.notificationHandlers.get(msg.method);
      if (h) {
        try {
          h(msg.params);
        } catch {
          /* a handler never breaks the connection */
        }
      } else if (!msg.method.startsWith("$/")) this.onUnhandled(msg.method);
    } else if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      else p.resolve(msg.result ?? null);
    }
  }

  private async answer(id: number | string, method: string, params: unknown) {
    const h = this.requestHandlers.get(method);
    if (!h) {
      this.onUnhandled(method);
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unhandled method ${method}` } }));
      return;
    }
    try {
      const result = await h(params);
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
    } catch (e) {
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error)?.message ?? e) } }));
    }
  }

  /** The server exited: every request still waiting fails. */
  close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new RpcError("The language server has stopped.", -32099));
    this.pending.clear();
  }
}
