// A JDWP connection over TCP: handshake, command/reply matching, VM events.
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { DEFAULT_ID_SIZES, Reader, Writer, type IdSizes } from "./packet";

const HANDSHAKE = "JDWP-Handshake";
const HEADER = 11;
const REPLY_FLAG = 0x80;

/** Human-readable names for the JDWP error codes students are likely to meet. */
const ERROR_NAMES: Record<number, string> = {
  10: "INVALID_THREAD",
  13: "THREAD_NOT_SUSPENDED",
  20: "INVALID_OBJECT",
  21: "INVALID_CLASS",
  23: "INVALID_METHODID",
  24: "INVALID_LOCATION",
  25: "INVALID_FIELDID",
  30: "INVALID_FRAMEID",
  34: "TYPE_MISMATCH",
  35: "INVALID_SLOT",
  41: "NOT_FOUND",
  99: "NOT_IMPLEMENTED",
  101: "ABSENT_INFORMATION",
  102: "INVALID_EVENT_TYPE",
  112: "VM_DEAD",
  502: "INVALID_TYPESTATE",
  506: "INVALID_STRING",
  508: "INVALID_ARRAY",
};

export class JdwpError extends Error {
  constructor(
    readonly code: number,
    readonly command: string,
  ) {
    super(`JDWP ${command} failed: ${ERROR_NAMES[code] ?? "error"} (${code})`);
  }
}

export interface ConnectOptions {
  host: string;
  port: number;
  /** Keep retrying a refused connection until this many ms have passed. */
  timeoutMs: number;
  /** Stop retrying early (e.g. the JVM process already exited). */
  aborted?: () => string | undefined;
}

export class JdwpConnection extends EventEmitter {
  sizes: IdSizes = { ...DEFAULT_ID_SIZES };
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reader) => void; reject: (e: Error) => void; name: string }>();
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;

  private constructor(private socket: net.Socket) {
    super();
    socket.on("data", (d) => this.onData(d));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
  }

  static async connect(opts: ConnectOptions): Promise<JdwpConnection> {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const why = opts.aborted?.();
      if (why) throw new Error(why);
      try {
        const socket = await handshake(opts.host, opts.port);
        return new JdwpConnection(socket);
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`Could not connect to the Java VM at ${opts.host}:${opts.port}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  get isClosed() {
    return this.closed;
  }

  writer(): Writer {
    return new Writer(this.sizes);
  }

  /** Sends a command and resolves with a reader positioned at the reply data. */
  command(set: number, cmd: number, build?: (w: Writer) => void, name = `${set}.${cmd}`): Promise<Reader> {
    if (this.closed) return Promise.reject(new JdwpError(112, name));
    const w = this.writer();
    build?.(w);
    const data = w.bytes();
    const id = this.nextId++;
    const header = Buffer.alloc(HEADER);
    header.writeUInt32BE(HEADER + data.length, 0);
    header.writeUInt32BE(id, 4);
    header.writeUInt8(0, 8);
    header.writeUInt8(set, 9);
    header.writeUInt8(cmd, 10);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, name });
      this.socket.write(Buffer.concat([header, data]));
    });
  }

  close() {
    this.socket.destroy();
    this.onClose();
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= HEADER) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < len) break;
      const packet = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      const id = packet.readUInt32BE(4);
      const flags = packet.readUInt8(8);
      if (flags & REPLY_FLAG) {
        const p = this.pending.get(id);
        if (!p) continue;
        this.pending.delete(id);
        const error = packet.readUInt16BE(9);
        if (error) p.reject(new JdwpError(error, p.name));
        else p.resolve(new Reader(packet.subarray(HEADER), this.sizes));
      } else {
        const set = packet.readUInt8(9);
        const cmd = packet.readUInt8(10);
        if (set === 64 && cmd === 100) this.emit("event", new Reader(packet.subarray(HEADER), this.sizes));
      }
    }
  }

  private onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new JdwpError(112, p.name));
    this.pending.clear();
    this.emit("close");
  }
}

function handshake(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let got = Buffer.alloc(0);
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error("handshake timed out")), 5000);
    socket.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("connection closed during handshake"));
    });
    socket.once("connect", () => socket.write(HANDSHAKE, "ascii"));
    const onData = (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length < HANDSHAKE.length) return;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (got.subarray(0, HANDSHAKE.length).toString("ascii") !== HANDSHAKE) return fail(new Error("bad JDWP handshake"));
      const rest = got.subarray(HANDSHAKE.length);
      resolve(socket);
      // Any packet bytes that arrived with the handshake reply.
      if (rest.length) setImmediate(() => socket.emit("data", rest));
    };
    socket.on("data", onData);
  });
}
