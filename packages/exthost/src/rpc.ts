/**
 * JSON-RPC between the workbench ("main thread") and the extension host,
 * VS Code's MainThread/ExtHost split in miniature. Both ends are peers: each
 * can send requests (with an id, answered by a response), notifications (no
 * id) and `$cancel` for a request it no longer needs.
 *
 * Over stdio (Node host) messages are framed like LSP/DAP
 * (`Content-Length: N\r\n\r\n<json>`), so the Rust side reuses its DAP framer
 * and stray output from an extension can never corrupt a message. A Web
 * Worker host posts the objects directly.
 */

export type RpcMessage =
  | { id: number; method: string; params: unknown[] }
  | { id: number; result: unknown }
  | { id: number; error: RpcErrorData }
  | { method: string; params: unknown[] };

export interface RpcErrorData {
  message: string;
  name?: string;
  stack?: string;
  /** "Canceled" when the request was cancelled. */
  code?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One message as a Content-Length frame (length in UTF-8 bytes, not characters). */
export function encodeFrame(message: RpcMessage | string): Uint8Array {
  const body = encoder.encode(typeof message === "string" ? message : JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

const MAX_MESSAGE = 64 * 1024 * 1024;

/**
 * Incremental frame parser: bytes arrive in arbitrary chunks (a frame may
 * span chunks, a chunk may hold several frames). Garbage before a header is
 * skipped, so a stray `console.log` cannot wedge the stream.
 */
export class FrameDecoder {
  #buf = new Uint8Array(0);

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);
    this.#buf = merged;
    const out: string[] = [];
    for (;;) {
      const msg = this.#next();
      if (msg === null) break;
      if (msg !== undefined) out.push(msg);
    }
    return out;
  }

  /** A message, undefined for skipped garbage (call again), null when more bytes are needed. */
  #next(): string | null | undefined {
    const buf = this.#buf;
    let end = -1;
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
        end = i;
        break;
      }
    }
    if (end < 0) {
      if (buf.length > 8192) this.#buf = new Uint8Array(0);
      return null;
    }
    const header = decoder.decode(buf.subarray(0, end));
    const m = /(?:^|\n)\s*content-length\s*:\s*(\d+)\s*$/im.exec(header);
    const length = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(length) || length > MAX_MESSAGE) {
      this.#buf = buf.subarray(end + 4);
      return undefined;
    }
    const start = end + 4;
    if (buf.length < start + length) return null;
    const body = decoder.decode(buf.subarray(start, start + length));
    this.#buf = buf.slice(start + length);
    return body;
  }
}

export class RpcError extends Error {
  code?: string;
  constructor(data: RpcErrorData) {
    super(data.message);
    this.name = data.name ?? "Error";
    this.code = data.code;
    if (data.stack) this.stack = data.stack;
  }
}

export type RpcHandler = (params: unknown[], cancel: { readonly cancelled: boolean; onCancel(fn: () => void): void }) => unknown;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** A peer: `send` writes one message; feed incoming ones to `handleMessage`. */
export class RpcConnection {
  #seq = 0;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, RpcHandler>();
  #inflight = new Map<number, { cancelled: boolean; listeners: (() => void)[] }>();
  #closed = false;
  /** Called for a method nobody registered (default: an error response / ignored notification). */
  fallback?: (method: string, params: unknown[]) => unknown;

  constructor(private readonly send: (message: RpcMessage) => void) {}

  register(method: string, handler: RpcHandler) {
    this.#handlers.set(method, handler);
    return () => this.#handlers.delete(method);
  }

  /** Sends a request; resolves with the peer's result. `signal` cancels it (rejects with Canceled). */
  request<T = unknown>(method: string, params: unknown[] = [], cancel?: { isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => unknown }): Promise<T> {
    if (this.#closed) return Promise.reject(new RpcError({ message: "The extension host is not running", code: "Closed" }));
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.#pending.delete(id);
        reject(e);
        return;
      }
      if (cancel) {
        const doCancel = () => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          reject(new RpcError({ message: "Canceled", name: "Canceled", code: "Canceled" }));
          try {
            this.send({ method: "$cancel", params: [id] });
          } catch {
            /* closed */
          }
        };
        if (cancel.isCancellationRequested) doCancel();
        else cancel.onCancellationRequested(doCancel);
      }
    });
  }

  notify(method: string, params: unknown[] = []) {
    if (this.#closed) return;
    try {
      this.send({ method, params });
    } catch {
      /* the peer is gone; nothing to tell */
    }
  }

  /** Handles one incoming message (already parsed, or JSON text). */
  handleMessage(raw: RpcMessage | string) {
    let msg: RpcMessage;
    try {
      msg = typeof raw === "string" ? (JSON.parse(raw) as RpcMessage) : raw;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if ("method" in msg) {
      if (msg.method === "$cancel") {
        const st = this.#inflight.get(Number(msg.params?.[0]));
        if (st && !st.cancelled) {
          st.cancelled = true;
          st.listeners.forEach((l) => l());
        }
        return;
      }
      const id = "id" in msg ? msg.id : undefined;
      void this.#dispatch(msg.method, Array.isArray(msg.params) ? msg.params : [], id);
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if ("error" in msg) p.reject(new RpcError(msg.error));
    else p.resolve(msg.result);
  }

  async #dispatch(method: string, params: unknown[], id: number | undefined) {
    const handler = this.#handlers.get(method);
    const state = { cancelled: false, listeners: [] as (() => void)[] };
    if (id !== undefined) this.#inflight.set(id, state);
    const token = {
      get cancelled() {
        return state.cancelled;
      },
      onCancel: (fn: () => void) => void state.listeners.push(fn),
    };
    try {
      let result: unknown;
      if (handler) result = await handler(params, token);
      else if (this.fallback) result = await this.fallback(method, params);
      else throw new Error(`Unknown method '${method}'`);
      if (id !== undefined) this.#reply({ id, result: result === undefined ? null : result });
    } catch (e) {
      if (id !== undefined) {
        const err = e as Error & { code?: string };
        this.#reply({ id, error: { message: String(err?.message ?? e), name: err?.name, stack: err?.stack, code: err?.code } });
      }
    } finally {
      if (id !== undefined) this.#inflight.delete(id);
    }
  }

  #reply(msg: RpcMessage) {
    if (this.#closed) return;
    try {
      this.send(msg);
    } catch {
      /* closed */
    }
  }

  /** The peer is gone: every pending request fails. */
  close(reason = "The extension host stopped") {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new RpcError({ message: reason, code: "Closed" }));
    this.#pending.clear();
  }

  get closed() {
    return this.#closed;
  }
}
