/**
 * The Debug Adapter Protocol subset TMCode speaks (microsoft.github.io/debug-adapter-protocol).
 * Only the fields the workbench reads or sends are typed; adapters may send more.
 */

export interface ProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
}

export interface Request extends ProtocolMessage {
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface Response extends ProtocolMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface Event extends ProtocolMessage {
  type: "event";
  event: string;
  body?: unknown;
}

export type Message = Request | Response | Event;

export interface ExceptionBreakpointsFilter {
  filter: string;
  label: string;
  description?: string;
  default?: boolean;
  supportsCondition?: boolean;
}

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsCompletionsRequest?: boolean;
  exceptionBreakpointFilters?: ExceptionBreakpointsFilter[];
}

export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: "normal" | "emphasize" | "deemphasize";
  origin?: string;
}

export interface SourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
}

export interface Thread {
  id: number;
  name: string;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  presentationHint?: "normal" | "label" | "subtle";
}

export interface Scope {
  name: string;
  presentationHint?: string;
  variablesReference: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: { kind?: string; attributes?: string[]; visibility?: string };
}

export interface InitializeArguments {
  clientID: string;
  clientName: string;
  adapterID: string;
  locale: string;
  linesStartAt1: boolean;
  columnsStartAt1: boolean;
  pathFormat: "path";
  supportsVariableType: boolean;
  supportsVariablePaging: boolean;
  supportsRunInTerminalRequest: boolean;
  supportsStartDebuggingRequest: boolean;
  supportsProgressReporting: boolean;
  supportsInvalidatedEvent: boolean;
  supportsMemoryReferences: boolean;
  supportsArgsCanBeInterpretedByShell: boolean;
}

export interface StoppedEventBody {
  reason: string;
  description?: string;
  threadId?: number;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
}

export interface OutputEventBody {
  category?: "console" | "important" | "stdout" | "stderr" | "telemetry" | string;
  output: string;
  variablesReference?: number;
  source?: Source;
  line?: number;
}

export interface EvaluateResponseBody {
  result: string;
  type?: string;
  variablesReference: number;
}

export interface RunInTerminalArguments {
  kind?: "integrated" | "external";
  title?: string;
  cwd: string;
  args: string[];
  env?: Record<string, string | null>;
}

export interface StartDebuggingArguments {
  configuration: Record<string, unknown>;
  request: "launch" | "attach";
}

// ───────────── base protocol framing ─────────────
// The desktop host frames messages in Rust (debug.rs); the browser build's
// simulated adapter goes through the same wire format here, so both paths
// exercise `Content-Length` framing.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_END = [13, 10, 13, 10];
const MAX_HEADER = 8192;

/** Frames one DAP message: `Content-Length: N\r\n\r\n<json>` (N counts UTF-8 bytes). */
export function encodeMessage(json: string): Uint8Array {
  const body = encoder.encode(json);
  const head = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Incremental DAP parser: bytes arrive in arbitrary chunks, `next()` yields whole message bodies. */
export class DapFrameReader {
  private buf = new Uint8Array(0);

  push(bytes: Uint8Array) {
    const next = new Uint8Array(this.buf.length + bytes.length);
    next.set(this.buf);
    next.set(bytes, this.buf.length);
    this.buf = next;
  }

  private headerEnd(): number {
    outer: for (let i = 0; i + 4 <= this.buf.length; i++) {
      for (let k = 0; k < 4; k++) if (this.buf[i + k] !== HEADER_END[k]) continue outer;
      return i;
    }
    return -1;
  }

  /** The next complete body, `null` if more bytes are needed; throws (dropping the bad header) on garbage. */
  next(): string | null {
    const end = this.headerEnd();
    if (end < 0) {
      if (this.buf.length > MAX_HEADER) {
        this.buf = new Uint8Array(0);
        throw new Error("DAP header too long");
      }
      return null;
    }
    const header = decoder.decode(this.buf.subarray(0, end));
    let length: number | null = null;
    for (const line of header.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0 && line.slice(0, i).trim().toLowerCase() === "content-length") {
        const n = Number(line.slice(i + 1).trim());
        if (Number.isInteger(n) && n >= 0) length = n;
      }
    }
    if (length === null) {
      this.buf = this.buf.slice(end + 4);
      throw new Error(`bad DAP header: ${JSON.stringify(header)}`);
    }
    const start = end + 4;
    if (this.buf.length < start + length) return null;
    const body = decoder.decode(this.buf.subarray(start, start + length));
    this.buf = this.buf.slice(start + length);
    return body;
  }

  /** Every complete message currently buffered (bad headers are skipped). */
  drain(onError?: (e: Error) => void): string[] {
    const out: string[] = [];
    for (;;) {
      try {
        const m = this.next();
        if (m === null) return out;
        out.push(m);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  }
}
