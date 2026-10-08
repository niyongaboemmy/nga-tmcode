// The DAP base protocol: Content-Length framed JSON over a byte stream.

export interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
  [key: string]: unknown;
}

export interface DapRequest extends DapMessage {
  type: "request";
  command: string;
  arguments?: any;
}

export interface DapResponse extends DapMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: any;
}

/** Incremental parser: feed it chunks, it calls `onMessage` for each complete message. */
export class DapReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onMessage: (m: DapMessage) => void) {}

  feed(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed header: drop it and resynchronise.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        // ignore unparsable messages
      }
    }
  }
}

export function encodeMessage(m: object): Buffer {
  const json = Buffer.from(JSON.stringify(m), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii"), json]);
}
