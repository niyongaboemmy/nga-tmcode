import type {
  Breakpoint,
  Capabilities,
  EvaluateResponseBody,
  Event,
  InitializeArguments,
  Message,
  Request,
  Response,
  Scope,
  Source,
  SourceBreakpoint,
  StackFrame,
  Thread,
  Variable,
} from "./dap";

/** Where the session's messages go: a platform DebugConnection (desktop) or the in-memory fake adapter. */
export interface DapTransport {
  send(message: string): void;
}

export class DapError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
  }
}

type EventHandler = (body: any, event: Event) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * One DAP client session: sequenced requests with promised responses, events
 * by name, and reverse requests (runInTerminal, startDebugging) answered by
 * the owner. It knows nothing about the workbench; debugService drives it.
 */
export class DapSession {
  private seq = 1;
  private pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void; command: string; timer?: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, Set<EventHandler>>();
  private closed = false;
  capabilities: Capabilities = {};
  /** Answers reverse requests; reject to fail them. */
  onReverseRequest: (command: string, args: any) => Promise<unknown> = async (command) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    throw new Error(`Unsupported request '${command}'`);
  };

  constructor(
    private transport: DapTransport,
    readonly adapterId: string,
  ) {}

  get isClosed() {
    return this.closed;
  }

  /** Feeds one message from the adapter (JSON text or an already-parsed object). */
  handleMessage(raw: string | Message) {
    let msg: Message;
    try {
      msg = typeof raw === "string" ? (JSON.parse(raw) as Message) : raw;
    } catch {
      return;
    }
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (p.timer) clearTimeout(p.timer);
      if (msg.success) p.resolve(msg);
      else p.reject(new DapError(responseError(msg), msg.command));
    } else if (msg.type === "event") {
      if (msg.event === "capabilities") Object.assign(this.capabilities, (msg.body as { capabilities?: Capabilities })?.capabilities);
      for (const key of [msg.event, "*"]) this.handlers.get(key)?.forEach((h) => h(msg.body ?? {}, msg));
    } else if (msg.type === "request") {
      void this.answer(msg);
    }
  }

  private async answer(req: Request) {
    try {
      const body = await this.onReverseRequest(req.command, req.arguments ?? {});
      this.write({ type: "response", request_seq: req.seq, command: req.command, success: true, body: body ?? {} });
    } catch (e) {
      this.write({ type: "response", request_seq: req.seq, command: req.command, success: false, message: String((e as Error)?.message ?? e) });
    }
  }

  private write(msg: Record<string, unknown>) {
    if (this.closed) return;
    this.transport.send(JSON.stringify({ seq: this.seq++, ...msg }));
  }

  /** Sends a request; resolves with its body, rejects with the adapter's message. */
  request<T = unknown>(command: string, args?: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new DapError("The debug session has ended.", command));
    const seq = this.seq++;
    return new Promise<Response>((resolve, reject) => {
      const entry: { resolve: (r: Response) => void; reject: (e: Error) => void; command: string; timer?: ReturnType<typeof setTimeout> } = { resolve, reject, command };
      if (timeoutMs > 0) entry.timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(`'${command}' timed out`, command));
      }, timeoutMs);
      this.pending.set(seq, entry);
      this.transport.send(JSON.stringify({ seq, type: "request", command, arguments: args }));
    }).then((r) => r.body as T);
  }

  on(event: string, handler: EventHandler) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Resolves with the next `event` (e.g. "initialized"), or rejects if the session closes first. */
  once(event: string, timeoutMs = 0): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve, reject) => {
      const off = this.on(event, (body) => {
        cleanup();
        resolve(body);
      });
      const offClose = this.on("__closed", () => {
        cleanup();
        reject(new DapError("The debug adapter exited.", event));
      });
      const timer = timeoutMs > 0 ? setTimeout(() => (cleanup(), reject(new DapError(`No '${event}' from the debugger`, event))), timeoutMs) : null;
      const cleanup = () => {
        off();
        offClose();
        if (timer) clearTimeout(timer);
      };
    });
  }

  /** The transport closed: fail everything still waiting. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new DapError("The debug session has ended.", p.command));
    }
    this.pending.clear();
    this.handlers.get("__closed")?.forEach((h) => h({}, { seq: 0, type: "event", event: "__closed" }));
  }

  // ───────────── typed requests ─────────────

  async initialize(adapterID: string, opts: { runInTerminal: boolean }) {
    const args: InitializeArguments = {
      clientID: "tmcode",
      clientName: "TMCode",
      adapterID,
      locale: "en",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: opts.runInTerminal,
      supportsStartDebuggingRequest: true,
      supportsProgressReporting: false,
      supportsInvalidatedEvent: false,
      supportsMemoryReferences: false,
      supportsArgsCanBeInterpretedByShell: false,
    };
    const caps = await this.request<Capabilities>("initialize", args, 30_000);
    this.capabilities = { ...this.capabilities, ...(caps ?? {}) };
    return this.capabilities;
  }

  launch(config: Record<string, unknown>) {
    return this.request("launch", config);
  }

  attach(config: Record<string, unknown>) {
    return this.request("attach", config);
  }

  async setBreakpoints(source: Source, breakpoints: SourceBreakpoint[]) {
    const body = await this.request<{ breakpoints: Breakpoint[] }>("setBreakpoints", { source, breakpoints, lines: breakpoints.map((b) => b.line), sourceModified: false });
    return body?.breakpoints ?? [];
  }

  setExceptionBreakpoints(filters: string[]) {
    return this.request("setExceptionBreakpoints", { filters });
  }

  configurationDone() {
    return this.capabilities.supportsConfigurationDoneRequest ? this.request("configurationDone", {}) : Promise.resolve();
  }

  async threads() {
    return (await this.request<{ threads: Thread[] }>("threads"))?.threads ?? [];
  }

  async stackTrace(threadId: number, levels = 50) {
    const body = await this.request<{ stackFrames: StackFrame[]; totalFrames?: number }>("stackTrace", { threadId, startFrame: 0, levels });
    return body?.stackFrames ?? [];
  }

  async scopes(frameId: number) {
    return (await this.request<{ scopes: Scope[] }>("scopes", { frameId }))?.scopes ?? [];
  }

  async variables(variablesReference: number) {
    return (await this.request<{ variables: Variable[] }>("variables", { variablesReference }))?.variables ?? [];
  }

  setVariable(variablesReference: number, name: string, value: string) {
    return this.request<{ value: string; type?: string; variablesReference?: number }>("setVariable", { variablesReference, name, value });
  }

  evaluate(expression: string, frameId: number | undefined, context: "watch" | "repl" | "hover" | "clipboard") {
    return this.request<EvaluateResponseBody>("evaluate", { expression, frameId, context });
  }

  continue(threadId: number) {
    return this.request("continue", { threadId });
  }
  next(threadId: number) {
    return this.request("next", { threadId });
  }
  stepIn(threadId: number) {
    return this.request("stepIn", { threadId });
  }
  stepOut(threadId: number) {
    return this.request("stepOut", { threadId });
  }
  pause(threadId: number) {
    return this.request("pause", { threadId });
  }
  restart(args?: Record<string, unknown>) {
    return this.request("restart", args ? { arguments: args } : {});
  }
  terminate() {
    return this.request("terminate", {}, 3000);
  }
  disconnect(terminateDebuggee = true) {
    return this.request("disconnect", { restart: false, terminateDebuggee }, 3000);
  }
}

function responseError(r: Response): string {
  const err = (r.body as { error?: { format?: string; variables?: Record<string, string> } } | undefined)?.error;
  if (err?.format) return err.format.replace(/\{(\w+)\}/g, (_, k) => err.variables?.[k] ?? k);
  return r.message || `'${r.command}' failed`;
}
