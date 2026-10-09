// The Java debug session: DAP requests in, JDWP commands out.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DapMessage, DapRequest, DapResponse } from "./dap";
import { EvalError, formatPrim, quoteString, type Val } from "./expr";
import { Evaluator, findField, paramSignatures, qualifiedTypeName, simpleTypeName, visibleLocals, type EvalContext } from "./evaluator";
import { JdwpConnection } from "./jdwp/connection";
import { Tag, type Location, type Value } from "./jdwp/packet";
import { ACC_STATIC, EventKind, StepDepth, StepSize, SuspendPolicy, Vm, parseEventSet, type EventSet, type Frame, type Modifier } from "./jdwp/vm";
import { Handles, Inspector, type DapVariable, type VarSpec } from "./values";

/** Arguments of the DAP `launch` request (VS Code Java naming where it exists). */
export interface LaunchArguments {
  /** Fully qualified main class, e.g. "Main", "com.example.App" or "MainKt". */
  mainClass: string;
  /** Class path entries (directories or jars); relative ones resolve against `cwd`. Default: [cwd]. */
  classPaths?: string[];
  /** Source roots used to map classes to files. Default: [cwd, cwd/src]. */
  sourcePaths?: string[];
  cwd?: string;
  /** Program arguments (an array, or one string split on whitespace). */
  args?: string[] | string;
  /** JVM options placed before -cp (an array, or one string split on whitespace). */
  vmArgs?: string[] | string;
  /** The java launcher. Default: "java" (on PATH). */
  javaExec?: string;
  /** Extra environment variables for the program. */
  env?: Record<string, string>;
  /** "integratedTerminal" runs the program through the client's runInTerminal (stdin works). Default "internalConsole". */
  console?: "integratedTerminal" | "externalTerminal" | "internalConsole";
  /** Stop on the first line of main(). */
  stopOnEntry?: boolean;
  /** Milliseconds to wait for the JVM's debug port. Default 15000. */
  timeout?: number;
}

/** Arguments of the DAP `attach` request, for a JVM started with -agentlib:jdwp=transport=dt_socket,server=y,... */
export interface AttachArguments {
  hostName?: string;
  port: number;
  sourcePaths?: string[];
  cwd?: string;
  timeout?: number;
}

interface Breakpoint {
  id: number;
  file: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified: boolean;
  requests: number[];
  classes: Set<bigint>;
  hits: number;
}

interface ClassInfo {
  id: bigint;
  tag: number;
  signature: string;
  sourceFile: string;
}

interface StopInfo {
  reason: "breakpoint" | "step" | "exception" | "pause" | "entry";
  thread: bigint;
  hitBreakpointIds?: number[];
  description?: string;
  text?: string;
}

interface ExceptionDetails {
  object: bigint;
  typeName: string;
  message: string | null;
  uncaught: boolean;
}

/** Packages never shown while stepping or watched for class loading. */
const LIBRARY_PATTERNS = ["java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "kotlin.*"];
const LIBRARY_SIGNATURES = ["Ljava/", "Ljavax/", "Ljdk/", "Lsun/", "Lcom/sun/", "Lkotlin/"];
const isLibrary = (sig: string) => LIBRARY_SIGNATURES.some((p) => sig.startsWith(p));

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T) => void;
  settled = false;
  constructor() {
    this.promise = new Promise((r) => (this.resolve = r));
    this.promise.then(() => (this.settled = true));
  }
}

class UserError extends Error {}

export class JavaDebugSession {
  private seq = 1;
  private clientCaps: Record<string, unknown> = {};
  private linesStartAt1 = true;
  private requestQueue: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();
  private pendingReverse = new Map<number, (r: DapResponse) => void>();

  private conn?: JdwpConnection;
  private vm?: Vm;
  private inspector?: Inspector;
  private child?: ChildProcess;
  private childClosed?: Promise<number>;
  private childExited: string | undefined;
  private childStderr = "";
  private launched = false;
  private sourcePaths: string[] = [];
  private stopOnEntry = false;
  private mainSignature = "";

  private configured = false;
  private started = false;
  private setupDone = new Deferred<void>();
  private vmStart = new Deferred<number>();
  private gone = false;
  private goneDone = new Deferred<void>();
  private exitCodeHint: number | undefined;
  private mainDiedUncaught = false;

  private breakpoints = new Map<string, Breakpoint[]>();
  private bpByRequest = new Map<number, Breakpoint>();
  private nextBpId = 1;
  private knownClasses = new Set<bigint>();
  private classesBySource = new Map<string, ClassInfo[]>();
  private exceptionFilters = { caught: false, uncaught: false };
  private exceptionRequests: number[] = [];
  private uncaughtWatchRequest = -1;
  private entryRequest = -1;
  private exitHookRequest = -1;
  private stepRequests = new Map<bigint, number>();

  private stopped: StopInfo | null = null;
  private pendingStops: StopInfo[] = [];
  private exceptions = new Map<bigint, ExceptionDetails>();
  private invoking = false;

  private threadHandles = new Handles<bigint>();
  private frameHandles = new Handles<{ thread: bigint; depth: number }>();
  private varHandles = new Handles<VarSpec>();
  private frameCache = new Map<bigint, Frame[]>();
  private sourceCache = new Map<bigint, string | null>();
  private packageCache = new Map<string, string | null>();

  constructor(
    private sendRaw: (m: object) => void,
    private onExit: () => void,
  ) {}

  // ───────────────────────── DAP plumbing ─────────────────────────

  handleMessage(m: DapMessage) {
    if (m.type === "response") {
      const r = m as DapResponse;
      this.pendingReverse.get(r.request_seq)?.(r);
      this.pendingReverse.delete(r.request_seq);
      return;
    }
    if (m.type !== "request") return;
    const req = m as DapRequest;
    // These must work even while another request (e.g. a slow launch or a hung evaluate) is pending.
    if (req.command === "disconnect" || req.command === "terminate") {
      void this.dispatch(req);
      return;
    }
    this.requestQueue = this.requestQueue.then(() => this.dispatch(req));
  }

  private async dispatch(req: DapRequest) {
    try {
      const result = (await this.handle(req.command, req.arguments ?? {})) ?? {};
      this.respond(req, true, result.body);
      await result.after?.();
    } catch (e) {
      const message = e instanceof UserError || e instanceof EvalError ? e.message : `${(e as Error).message ?? e}`;
      this.log(`request ${req.command} failed: ${(e as Error).stack ?? e}`);
      this.respond(req, false, { error: { id: 1, format: message, showUser: req.command === "launch" || req.command === "attach" } }, message);
    }
  }

  private respond(req: DapRequest, success: boolean, body?: unknown, message?: string) {
    this.sendRaw({ seq: this.seq++, type: "response", request_seq: req.seq, command: req.command, success, message, body });
  }

  private sendEvent(event: string, body?: unknown) {
    this.sendRaw({ seq: this.seq++, type: "event", event, body });
  }

  private reverseRequest(command: string, args: unknown): Promise<DapResponse> {
    const seq = this.seq++;
    return new Promise((resolve) => {
      this.pendingReverse.set(seq, resolve);
      this.sendRaw({ seq, type: "request", command, arguments: args });
    });
  }

  private output(category: "console" | "stdout" | "stderr" | "important", output: string) {
    if (output) this.sendEvent("output", { category, output });
  }

  private log(msg: string) {
    if (process.env.JAVA_DAP_LOG) process.stderr.write(`[java-dap] ${msg}\n`);
  }

  private line(n: number) {
    return this.linesStartAt1 ? n : n - 1;
  }
  private clientLine(n: number) {
    return this.linesStartAt1 ? n : n + 1;
  }

  /** The adapter's stdin closed: clean up and leave. */
  shutdown() {
    if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
    this.conn?.close();
    this.onExit();
  }

  private async handle(command: string, a: any): Promise<{ body?: unknown; after?: () => unknown } | void> {
    switch (command) {
      case "initialize":
        this.clientCaps = a;
        this.linesStartAt1 = a.linesStartAt1 !== false;
        return { body: capabilities() };
      case "launch":
        await this.launch(a as LaunchArguments);
        return { after: () => this.sendEvent("initialized") };
      case "attach":
        await this.attach(a as AttachArguments);
        return { after: () => this.sendEvent("initialized") };
      case "setBreakpoints":
        return { body: await this.setBreakpoints(a) };
      case "setExceptionBreakpoints":
        this.exceptionFilters = { caught: (a.filters ?? []).includes("caught"), uncaught: (a.filters ?? []).includes("uncaught") };
        if (this.vm && this.setupDone.settled) await this.applyExceptionRequests();
        return { body: {} };
      case "configurationDone":
        this.configured = true;
        return { after: () => this.startIfReady() };
      case "threads":
        return { body: { threads: await this.threads() } };
      case "stackTrace":
        return { body: await this.stackTrace(a) };
      case "scopes":
        return { body: { scopes: await this.scopes(a.frameId) } };
      case "variables":
        return { body: { variables: await this.variables(a.variablesReference) } };
      case "setVariable":
        return { body: await this.setVariable(a.variablesReference, a.name, a.value) };
      case "evaluate":
        return { body: await this.evaluate(a.expression, a.frameId, a.context) };
      case "exceptionInfo":
        return { body: this.exceptionInfo(a.threadId) };
      case "continue":
        this.requireVm();
        return { body: { allThreadsContinued: true }, after: () => this.resumeAll() };
      case "next":
        return { after: await this.prepareStep(a.threadId, StepDepth.OVER) };
      case "stepIn":
        return { after: await this.prepareStep(a.threadId, StepDepth.INTO) };
      case "stepOut":
        return { after: await this.prepareStep(a.threadId, StepDepth.OUT) };
      case "pause":
        return { after: () => this.pause() };
      case "terminate":
        await this.terminate();
        return;
      case "disconnect":
        await this.disconnect(a.terminateDebuggee);
        return { after: () => this.onExit() };
      case "source":
        throw new UserError("Source is not available for this frame.");
      default:
        throw new UserError(`Unsupported request: ${command}`);
    }
  }

  // ───────────────────────── launch / attach ─────────────────────────

  private async launch(a: LaunchArguments) {
    if (!a.mainClass) throw new UserError('Set "mainClass" (e.g. "Main" or "com.example.App") to debug a Java program.');
    this.launched = true;
    const cwd = path.resolve(a.cwd ?? process.cwd());
    const classPaths = (a.classPaths?.length ? a.classPaths : [cwd]).map((p) => path.resolve(cwd, p));
    this.sourcePaths = (a.sourcePaths?.length ? a.sourcePaths : [cwd, path.join(cwd, "src")]).map((p) => path.resolve(cwd, p));
    this.stopOnEntry = !!a.stopOnEntry;
    this.mainSignature = `L${a.mainClass.replace(/\./g, "/")};`;
    const port = await freePort();
    const java = a.javaExec || "java";
    const cmd = [
      java,
      `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port},quiet=y`,
      ...splitArgs(a.vmArgs),
      "-cp",
      classPaths.join(path.delimiter),
      a.mainClass,
      ...splitArgs(a.args),
    ];

    const terminal = (a.console === "integratedTerminal" || a.console === "externalTerminal") && this.clientCaps.supportsRunInTerminalRequest === true;
    if (terminal) {
      const r = await this.reverseRequest("runInTerminal", {
        kind: a.console === "externalTerminal" ? "external" : "integrated",
        title: `Java: ${a.mainClass}`,
        cwd,
        args: cmd,
        env: a.env ?? {},
      });
      if (!r.success) throw new UserError(`Could not start the program in the terminal: ${r.message ?? "runInTerminal failed"}`);
    } else {
      this.spawnJvm(cmd, cwd, a.env);
    }
    try {
      await this.connect("127.0.0.1", port, a.timeout ?? 15000);
    } catch (e) {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
      throw new UserError((e as Error).message);
    }
  }

  private spawnJvm(cmd: string[], cwd: string, env?: Record<string, string>) {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    child.stdout!.on("data", (d: Buffer) => this.output("stdout", out.write(d)));
    child.stderr!.on("data", (d: Buffer) => {
      const s = err.write(d);
      this.childStderr = (this.childStderr + s).slice(-4000);
      this.output("stderr", s);
    });
    this.childClosed = new Promise((resolve) => {
      child.on("error", (e) => {
        this.childExited = `Could not start "${cmd[0]}": ${e.message}. Is a JDK installed and on the PATH?`;
        resolve(1);
      });
      child.on("close", (code, signal) => {
        this.childExited ??= `The Java VM exited (code ${code ?? signal}) before the debugger could connect.${this.childStderr ? `\n${this.childStderr.trim()}` : ""}`;
        resolve(code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1));
      });
    });
  }

  private async attach(a: AttachArguments) {
    if (!a.port) throw new UserError('Set "port" to the JDWP port of the running JVM.');
    const cwd = path.resolve(a.cwd ?? process.cwd());
    this.sourcePaths = (a.sourcePaths?.length ? a.sourcePaths : [cwd, path.join(cwd, "src")]).map((p) => path.resolve(cwd, p));
    await this.connect(a.hostName || "127.0.0.1", a.port, a.timeout ?? 15000);
  }

  private async connect(host: string, port: number, timeoutMs: number) {
    const conn = await JdwpConnection.connect({ host, port, timeoutMs, aborted: () => this.childExited });
    this.conn = conn;
    const vm = new Vm(conn);
    this.vm = vm;
    this.inspector = new Inspector(vm, this.varHandles);
    conn.on("event", (r) => {
      const set = parseEventSet(r);
      // While a method runs for an evaluation, its events must be handled at once
      // (the evaluation may itself be running inside the event queue).
      if (this.invoking) void this.onEventSet(set).catch((e) => this.log(`event: ${e.stack ?? e}`));
      else this.eventQueue = this.eventQueue.then(() => this.setupDone.promise).then(() => this.onEventSet(set)).catch((e) => this.log(`event: ${e.stack ?? e}`));
    });
    conn.on("close", () => void this.onVmGone());

    await vm.idSizes();
    this.log(`connected to ${await vm.version()}`);
    await vm.setRequest(EventKind.CLASS_PREPARE, SuspendPolicy.ALL, LIBRARY_PATTERNS.map((pattern) => ({ kind: "classExclude", pattern }) as Modifier));
    if (!this.child) {
      // Not our process: learn System.exit codes from java.lang.Shutdown.exit(int).
      await vm.setRequest(EventKind.CLASS_PREPARE, SuspendPolicy.ALL, [{ kind: "classMatch", pattern: "java.lang.Shutdown" }]);
      for (const c of await vm.classesBySignature("Ljava/lang/Shutdown;")) await this.installExitHook(c.id, c.tag);
    }
    for (const c of await vm.allClasses()) {
      if (!isLibrary(c.signature) && c.status & 2 /* PREPARED */) await this.registerClass(c.tag, c.id, c.signature);
    }
    await this.applyExceptionRequests();
    this.setupDone.resolve();
  }

  /** Resumes the VM once the client finished configuring breakpoints. */
  private async startIfReady() {
    if (!this.vm || this.started || !this.configured) return;
    this.started = true;
    // A VM started with suspend=y reports VMStart with SUSPEND_ALL; balance that suspension.
    const policy = await Promise.race([this.vmStart.promise, new Promise<number>((r) => setTimeout(() => r(SuspendPolicy.NONE), this.launched ? 10000 : 1500))]);
    if (policy !== SuspendPolicy.NONE && !this.gone) await this.vm.resume().catch(() => {});
  }

  // ───────────────────────── events ─────────────────────────

  private async onEventSet(set: EventSet) {
    const vm = this.vm!;
    this.frameCache.clear();
    let stop: StopInfo | null = null;
    let resume = set.suspendPolicy !== SuspendPolicy.NONE;
    let death = false;
    let thread: bigint | undefined;
    const rank = (s: StopInfo | null) => (s ? (s.reason === "step" ? 1 : 2) : 0);
    for (const e of set.events) {
      try {
        let s: StopInfo | null = null;
        switch (e.kind) {
          case EventKind.VM_START:
            this.vmStart.resolve(set.suspendPolicy);
            resume = false;
            break;
          case EventKind.VM_DEATH:
            death = true;
            resume = false;
            break;
          case EventKind.CLASS_PREPARE:
            thread = e.thread;
            if (e.signature === "Ljava/lang/Shutdown;") await this.installExitHook(e.typeId, e.refTag);
            else await this.registerClass(e.refTag, e.typeId, e.signature);
            break;
          case EventKind.BREAKPOINT:
            thread = e.thread;
            s = await this.onBreakpoint(e);
            break;
          case EventKind.SINGLE_STEP:
            thread = e.thread;
            await this.clearStep(e.thread);
            s = { reason: "step", thread: e.thread };
            break;
          case EventKind.EXCEPTION:
            thread = e.thread;
            s = await this.onException(e, set.suspendPolicy);
            break;
        }
        if (rank(s) > rank(stop)) stop = s;
      } catch (err) {
        this.log(`event ${e.kind}: ${(err as Error).stack ?? err}`);
      }
    }
    if (stop && !this.invoking && set.suspendPolicy === SuspendPolicy.ALL) {
      await this.clearStep(stop.thread);
      if (this.stopped) this.pendingStops.push(stop);
      else this.present(stop);
      return;
    }
    if (resume) {
      if (set.suspendPolicy === SuspendPolicy.ALL) await vm.resume().catch(() => {});
      else if (thread !== undefined) await vm.resumeThread(thread).catch(() => {});
    }
    if (death) await this.onVmGone();
  }

  private present(stop: StopInfo) {
    this.stopped = stop;
    this.sendEvent("stopped", {
      reason: stop.reason,
      threadId: this.threadHandle(stop.thread),
      allThreadsStopped: true,
      preserveFocusHint: false,
      hitBreakpointIds: stop.hitBreakpointIds,
      description: stop.description,
      text: stop.text,
    });
  }

  private async onBreakpoint(e: { requestId: number; thread: bigint; location: Location }): Promise<StopInfo | null> {
    if (e.requestId === this.entryRequest) {
      await this.vm!.clearRequest(EventKind.BREAKPOINT, e.requestId).catch(() => {});
      this.entryRequest = -1;
      return this.invoking ? null : { reason: "entry", thread: e.thread };
    }
    if (e.requestId === this.exitHookRequest) {
      const [frame] = await this.vm!.frames(e.thread, 0, 1);
      const [code] = await this.vm!.frameValues(e.thread, frame.id, [{ slot: 0, tag: Tag.INT }]);
      this.exitCodeHint = Number(code.value);
      return null;
    }
    const bp = this.bpByRequest.get(e.requestId);
    if (!bp || this.invoking) return null;
    bp.hits++;
    if (bp.hitCondition && !hitConditionMet(bp.hitCondition, bp.hits)) return null;
    if (bp.condition) {
      try {
        const ev = new Evaluator(this.evalContext(e.thread, 0));
        if (!(await ev.truth(await ev.evaluate(bp.condition)))) return null;
      } catch (err) {
        this.output("console", `Breakpoint condition "${bp.condition}" at ${path.basename(bp.file)}:${bp.line} could not be evaluated: ${(err as Error).message}\n`);
      }
    }
    if (bp.logMessage) {
      this.output("console", (await this.interpolate(bp.logMessage, e.thread)) + "\n");
      return null;
    }
    return { reason: "breakpoint", thread: e.thread, hitBreakpointIds: [bp.id] };
  }

  private async interpolate(template: string, thread: bigint): Promise<string> {
    const ev = new Evaluator(this.evalContext(thread, 0));
    let out = "";
    const re = /\{([^{}]+)\}/g;
    let last = 0;
    for (let m = re.exec(template); m; m = re.exec(template)) {
      out += template.slice(last, m.index);
      try {
        out += await ev.javaString(await ev.evaluate(m[1]));
      } catch (err) {
        out += `<${(err as Error).message}>`;
      }
      last = m.index + m[0].length;
    }
    return out + template.slice(last);
  }

  private async onException(e: { requestId: number; thread: bigint; exception: Value; catchLocation: Location | null }, policy: number): Promise<StopInfo | null> {
    const vm = this.vm!;
    const uncaught = e.catchLocation === null;
    if (uncaught && (await vm.threadName(e.thread).catch(() => "")) === "main") this.mainDiedUncaught = true;
    if (policy === SuspendPolicy.NONE || this.invoking) return null;
    // Exceptions the JDK throws and catches itself are noise for students.
    if (!uncaught && isLibrary(await vm.signature(e.catchLocation!.classId))) return null;
    const ex = e.exception.value as bigint;
    const ev = new Evaluator(this.evalContext(e.thread, 0));
    const full = await ev.describeThrowable(ex);
    const typeName = qualifiedTypeName(await vm.signature((await vm.objectType(ex)).id));
    const message = full.length > typeName.length ? full.slice(typeName.length + 2) : null;
    this.exceptions.set(e.thread, { object: ex, typeName, message, uncaught });
    return { reason: "exception", thread: e.thread, description: `${uncaught ? "Uncaught" : "Caught"} exception: ${typeName}`, text: full };
  }

  private async onVmGone() {
    if (this.gone) return this.goneDone.promise;
    this.gone = true;
    this.stopped = null;
    let code: number;
    if (this.childClosed) {
      const timeout = new Promise<number | undefined>((r) => setTimeout(() => r(undefined), 5000));
      const c = await Promise.race([this.childClosed, timeout]);
      if (c === undefined) {
        this.child?.kill("SIGKILL");
        code = (await this.childClosed) ?? 1;
      } else code = c;
    } else code = this.exitCodeHint ?? (this.mainDiedUncaught ? 1 : 0);
    this.conn?.close();
    this.sendEvent("exited", { exitCode: code });
    this.sendEvent("terminated");
    this.goneDone.resolve();
  }

  // ───────────────────────── run control ─────────────────────────

  private requireVm(): Vm {
    if (!this.vm || this.gone) throw new UserError("The Java program is not running.");
    return this.vm;
  }

  private async resumeAll() {
    const vm = this.requireVm();
    this.stopped = null;
    this.frameCache.clear();
    this.exceptions.clear();
    const next = this.pendingStops.shift();
    await vm.resume().catch(() => {});
    if (next) this.present(next);
  }

  private async prepareStep(threadId: number, depth: number) {
    const vm = this.requireVm();
    const thread = this.threadOf(threadId);
    await this.clearStep(thread);
    const id = await vm.setRequest(EventKind.SINGLE_STEP, SuspendPolicy.ALL, [
      { kind: "step", thread, size: StepSize.LINE, depth },
      ...LIBRARY_PATTERNS.map((pattern) => ({ kind: "classExclude", pattern }) as Modifier),
    ]);
    this.stepRequests.set(thread, id);
    return () => this.resumeAll();
  }

  private async clearStep(thread: bigint) {
    const id = this.stepRequests.get(thread);
    if (id === undefined) return;
    this.stepRequests.delete(thread);
    await this.vm?.clearRequest(EventKind.SINGLE_STEP, id).catch(() => {});
  }

  private async pause() {
    const vm = this.requireVm();
    if (this.stopped) return;
    await vm.suspend();
    const threads = await vm.allThreads();
    let pick = threads[0];
    for (const t of threads) if ((await vm.threadName(t).catch(() => "")) === "main") pick = t;
    this.present({ reason: "pause", thread: pick });
  }

  private async terminate() {
    if (this.gone || (!this.vm && !this.child)) {
      if (!this.gone) {
        this.gone = true;
        this.sendEvent("terminated");
      }
      return;
    }
    if (this.vm && !this.conn?.isClosed) await this.vm.exit(1).catch(() => {});
    else this.child?.kill();
    const child = this.child;
    if (child) setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
  }

  private async disconnect(terminateDebuggee?: boolean) {
    const kill = terminateDebuggee ?? this.launched;
    if (kill) {
      await this.terminate();
      if (this.vm || this.child) await Promise.race([this.goneDone.promise, new Promise((r) => setTimeout(r, 3000))]);
    } else if (this.vm && !this.gone) {
      // Dispose cancels our requests and resumes every thread we suspended.
      await this.vm.dispose().catch(() => {});
      this.conn?.close();
    }
  }

  // ───────────────────────── breakpoints ─────────────────────────

  private async setBreakpoints(a: any) {
    const sourcePath: string | undefined = a.source?.path;
    const wanted: { line: number; condition?: string; hitCondition?: string; logMessage?: string }[] = a.breakpoints ?? (a.lines ?? []).map((line: number) => ({ line }));
    if (!sourcePath) return { breakpoints: wanted.map(() => ({ verified: false, message: "Only files on disk can have breakpoints." })) };
    const file = path.resolve(sourcePath);
    for (const old of this.breakpoints.get(file) ?? []) await this.uninstall(old);
    const bps: Breakpoint[] = wanted.map((b) => ({
      id: this.nextBpId++,
      file,
      line: this.clientLine(b.line),
      condition: b.condition?.trim() || undefined,
      hitCondition: b.hitCondition?.trim() || undefined,
      logMessage: b.logMessage || undefined,
      verified: false,
      requests: [],
      classes: new Set(),
      hits: 0,
    }));
    this.breakpoints.set(file, bps);
    if (this.vm && !this.gone) {
      for (const bp of bps) {
        for (const cls of this.classesBySource.get(path.basename(file)) ?? []) if (this.classMatchesFile(cls, file)) await this.install(bp, cls);
      }
    }
    return { breakpoints: bps.map((bp) => this.toDapBreakpoint(bp)) };
  }

  private toDapBreakpoint(bp: Breakpoint) {
    return {
      id: bp.id,
      verified: bp.verified,
      line: this.line(bp.line),
      source: { name: path.basename(bp.file), path: bp.file },
      message: bp.verified ? undefined : "The breakpoint is set when its class loads (no code on this line yet).",
    };
  }

  private async uninstall(bp: Breakpoint) {
    for (const id of bp.requests) {
      this.bpByRequest.delete(id);
      await this.vm?.clearRequest(EventKind.BREAKPOINT, id).catch(() => {});
    }
    bp.requests = [];
  }

  /** Puts `bp` into one class (if the class has code on its line). Returns true when the bp changed. */
  private async install(bp: Breakpoint, cls: ClassInfo): Promise<boolean> {
    if (bp.classes.has(cls.id)) return false;
    bp.classes.add(cls.id);
    const before = `${bp.verified}:${bp.line}`;
    let locs = await this.locationsForLine(cls, bp.line);
    if (!locs.length && !bp.verified && this.lineHasNoCode(bp.file, bp.line)) {
      const next = await this.nextCodeLine(cls, bp.line);
      if (next !== null) {
        bp.line = next;
        locs = await this.locationsForLine(cls, next);
      }
    }
    for (const location of locs) {
      const id = await this.vm!.setRequest(EventKind.BREAKPOINT, SuspendPolicy.ALL, [{ kind: "location", location }]);
      bp.requests.push(id);
      this.bpByRequest.set(id, bp);
    }
    if (locs.length) bp.verified = true;
    return before !== `${bp.verified}:${bp.line}`;
  }

  private async locationsForLine(cls: ClassInfo, line: number): Promise<Location[]> {
    const out: Location[] = [];
    for (const m of await this.vm!.methods(cls.id)) {
      const lt = await this.vm!.lineTable(cls.id, m.id);
      if (!lt) continue;
      let best: bigint | null = null;
      for (const l of lt.lines) if (l.line === line && (best === null || l.index < best)) best = l.index;
      if (best !== null) out.push({ tag: cls.tag, classId: cls.id, methodId: m.id, index: best });
    }
    return out;
  }

  /** The first line at or after `line` with code, inside a method whose lines span `line`. */
  private async nextCodeLine(cls: ClassInfo, line: number): Promise<number | null> {
    let best: number | null = null;
    for (const m of await this.vm!.methods(cls.id)) {
      const lt = await this.vm!.lineTable(cls.id, m.id);
      if (!lt?.lines.length) continue;
      const lines = lt.lines.map((l) => l.line);
      if (Math.min(...lines) > line || Math.max(...lines) < line) continue;
      for (const l of lines) if (l >= line && (best === null || l < best)) best = l;
    }
    return best;
  }

  /** Blank lines, comments and lone braces never have code: such breakpoints may move down. */
  private lineHasNoCode(file: string, line: number): boolean {
    try {
      const text = fs.readFileSync(file, "utf8").split(/\r?\n/)[line - 1];
      if (text === undefined) return false;
      const t = text.trim();
      return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || /^[{}]+$/.test(t) || /^@\w+/.test(t);
    } catch {
      return false;
    }
  }

  private filePackage(file: string): string | null {
    if (this.packageCache.has(file)) return this.packageCache.get(file)!;
    let pkg: string | null = null;
    try {
      const m = /^\s*package\s+([\w.]+)/m.exec(fs.readFileSync(file, "utf8"));
      pkg = m ? m[1] : "";
    } catch {
      pkg = null;
    }
    this.packageCache.set(file, pkg);
    return pkg;
  }

  private classMatchesFile(cls: ClassInfo, file: string): boolean {
    if (cls.sourceFile !== path.basename(file)) return false;
    const pkg = this.filePackage(file);
    if (pkg === null) return true;
    return pkg.replace(/\./g, "/") === classPackageDir(cls.signature);
  }

  private async registerClass(tag: number, id: bigint, signature: string) {
    if (this.knownClasses.has(id) || isLibrary(signature)) return;
    this.knownClasses.add(id);
    const sourceFile = await this.vm!.sourceFile(id);
    if (sourceFile) {
      const cls: ClassInfo = { id, tag, signature, sourceFile };
      const list = this.classesBySource.get(sourceFile) ?? [];
      list.push(cls);
      this.classesBySource.set(sourceFile, list);
      for (const [file, bps] of this.breakpoints) {
        if (!this.classMatchesFile(cls, file)) continue;
        for (const bp of bps) if (await this.install(bp, cls)) this.sendEvent("breakpoint", { reason: "changed", breakpoint: this.toDapBreakpoint(bp) });
      }
    }
    if (this.stopOnEntry && signature === this.mainSignature && this.entryRequest < 0) await this.installEntry(tag, id);
  }

  private async installEntry(tag: number, classId: bigint) {
    const methods = await this.vm!.methods(classId);
    const main = methods.find((m) => m.name === "main" && m.signature === "([Ljava/lang/String;)V") ?? methods.find((m) => m.name === "main");
    if (!main) return;
    const lt = await this.vm!.lineTable(classId, main.id);
    const index = lt?.lines[0]?.index ?? 0n;
    this.entryRequest = await this.vm!.setRequest(EventKind.BREAKPOINT, SuspendPolicy.ALL, [{ kind: "location", location: { tag, classId, methodId: main.id, index } }]);
  }

  private async installExitHook(classId: bigint, tag: number) {
    if (this.exitHookRequest >= 0) return;
    const exit = (await this.vm!.methods(classId)).find((m) => m.name === "exit" && m.signature === "(I)V");
    if (!exit) return;
    this.exitHookRequest = await this.vm!.setRequest(EventKind.BREAKPOINT, SuspendPolicy.ALL, [{ kind: "location", location: { tag, classId, methodId: exit.id, index: 0n } }]);
  }

  private async applyExceptionRequests() {
    const vm = this.vm!;
    for (const id of this.exceptionRequests) await vm.clearRequest(EventKind.EXCEPTION, id).catch(() => {});
    this.exceptionRequests = [];
    // Always watch uncaught exceptions (without suspending) to know the exit code of terminal runs.
    this.uncaughtWatchRequest = await vm.setRequest(EventKind.EXCEPTION, this.exceptionFilters.uncaught ? SuspendPolicy.ALL : SuspendPolicy.NONE, [
      { kind: "exception", refType: 0n, caught: false, uncaught: true },
    ]);
    this.exceptionRequests.push(this.uncaughtWatchRequest);
    if (this.exceptionFilters.caught) {
      this.exceptionRequests.push(await vm.setRequest(EventKind.EXCEPTION, SuspendPolicy.ALL, [{ kind: "exception", refType: 0n, caught: true, uncaught: false }]));
    }
  }

  private exceptionInfo(threadId: number) {
    const info = this.exceptions.get(this.threadOf(threadId));
    if (!info) throw new UserError("No exception on this thread.");
    return {
      exceptionId: info.typeName,
      description: info.message ?? info.typeName,
      breakMode: info.uncaught ? "unhandled" : "always",
      details: { message: info.message ?? undefined, typeName: info.typeName.slice(info.typeName.lastIndexOf(".") + 1), fullTypeName: info.typeName, evaluateName: undefined },
    };
  }

  // ───────────────────────── inspection ─────────────────────────

  private threadHandle(thread: bigint): number {
    return this.threadHandles.get(String(thread), () => thread);
  }

  private threadOf(threadId: number): bigint {
    const t = this.threadHandles.lookup(threadId);
    if (t === undefined) throw new UserError(`Unknown thread ${threadId}.`);
    return t;
  }

  private async threads() {
    if (!this.vm || this.gone) return [];
    const out = [];
    for (const t of await this.vm.allThreads().catch(() => [] as bigint[])) {
      const name = await this.vm.threadName(t).catch(() => null);
      if (name !== null) out.push({ id: this.threadHandle(t), name });
    }
    return out;
  }

  private async framesOf(thread: bigint): Promise<Frame[]> {
    let frames = this.frameCache.get(thread);
    if (!frames) {
      try {
        frames = await this.requireVm().frames(thread, 0, -1);
      } catch (e) {
        throw new UserError(/THREAD_NOT_SUSPENDED/.test(String(e)) ? "The thread is running; pause the program to see its stack." : (e as Error).message);
      }
      this.frameCache.set(thread, frames);
    }
    return frames;
  }

  private async frameAt(thread: bigint, depth: number): Promise<Frame> {
    const f = (await this.framesOf(thread))[depth];
    if (!f) throw new UserError("That stack frame no longer exists.");
    return f;
  }

  private evalContext(thread: bigint, depth: number): EvalContext {
    return {
      vm: this.requireVm(),
      thread,
      frame: () => this.frameAt(thread, depth),
      invalidateFrames: () => this.frameCache.delete(thread),
      setInvoking: (on) => (this.invoking = on),
    };
  }

  private async stackTrace(a: { threadId: number; startFrame?: number; levels?: number }) {
    const vm = this.requireVm();
    const thread = this.threadOf(a.threadId);
    const frames = await this.framesOf(thread);
    const start = a.startFrame ?? 0;
    const end = a.levels ? Math.min(frames.length, start + a.levels) : frames.length;
    const stackFrames = [];
    for (let depth = start; depth < end; depth++) {
      const loc = frames[depth].location;
      const sig = await vm.signature(loc.classId);
      const method = await vm.method(loc.classId, loc.methodId);
      const line = await vm.lineOf(loc);
      const file = await this.sourceFor(loc.classId);
      const sourceName = await vm.sourceFile(loc.classId);
      const params = method ? paramSignatures(method.signature).map(simpleTypeName).join(", ") : "";
      stackFrames.push({
        id: this.frameHandles.get(`${thread}:${depth}`, () => ({ thread, depth })),
        name: `${simpleTypeName(sig)}.${method?.name ?? "?"}(${params})`,
        line: this.line(Math.max(line, 1)),
        column: 1,
        source: file ? { name: path.basename(file), path: file } : sourceName ? { name: sourceName, presentationHint: "deemphasize" } : undefined,
        presentationHint: file ? "normal" : "subtle",
      });
    }
    return { stackFrames, totalFrames: frames.length };
  }

  /** Maps a class to its source file via the breakpoint files and the source roots. */
  private async sourceFor(classId: bigint): Promise<string | null> {
    if (this.sourceCache.has(classId)) return this.sourceCache.get(classId)!;
    const vm = this.requireVm();
    const sourceFile = await vm.sourceFile(classId);
    let found: string | null = null;
    if (sourceFile) {
      const signature = await vm.signature(classId);
      const cls: ClassInfo = { id: classId, tag: 1, signature, sourceFile };
      for (const file of this.breakpoints.keys()) {
        if (this.classMatchesFile(cls, file)) {
          found = file;
          break;
        }
      }
      if (!found && !isLibrary(signature)) {
        const pkgDir = classPackageDir(signature);
        outer: for (const root of this.sourcePaths) {
          for (const candidate of [path.join(root, pkgDir, sourceFile), path.join(root, sourceFile)]) {
            if (fs.existsSync(candidate)) {
              found = candidate;
              break outer;
            }
          }
        }
      }
    }
    this.sourceCache.set(classId, found);
    return found;
  }

  private frameRef(frameId: number) {
    const f = this.frameHandles.lookup(frameId);
    if (!f) throw new UserError(`Unknown frame ${frameId}.`);
    return f;
  }

  private async scopes(frameId: number) {
    const vm = this.requireVm();
    const { thread, depth } = this.frameRef(frameId);
    const frame = await this.frameAt(thread, depth);
    const scopes: object[] = [
      { name: "Locals", presentationHint: "locals", variablesReference: this.varHandles.get(`locals:${frameId}`, () => ({ kind: "locals", frameRef: frameId })), expensive: false },
    ];
    const classId = frame.location.classId;
    const statics = (await vm.fields(classId)).filter((f) => f.modifiers & ACC_STATIC && !(f.modifiers & 0xf0000000) && !f.name.startsWith("$"));
    if (statics.length) {
      scopes.push({ name: `Static (${simpleTypeName(await vm.signature(classId))})`, variablesReference: this.varHandles.get(`statics:${classId}`, () => ({ kind: "statics", classId })), expensive: false });
    }
    return scopes;
  }

  private async variables(ref: number): Promise<DapVariable[]> {
    const spec = this.varHandles.lookup(ref);
    if (!spec) throw new UserError(`Unknown variables reference ${ref}.`);
    this.requireVm();
    if (spec.kind === "locals") return this.locals(spec.frameRef);
    return this.inspector!.children(spec);
  }

  private async locals(frameRef: number): Promise<DapVariable[]> {
    const vm = this.requireVm();
    const { thread, depth } = this.frameRef(frameRef);
    const frame = await this.frameAt(thread, depth);
    const out: DapVariable[] = [];
    const exception = this.exceptions.get(thread);
    if (depth === 0 && exception && this.stopped?.thread === thread) {
      out.push({ name: "<exception>", ...(await this.inspector!.present({ tag: Tag.OBJECT, value: exception.object })) });
    }
    const self = await vm.thisObject(thread, frame.id).catch(() => ({ tag: Tag.OBJECT, value: 0n }) as Value);
    if (self.value !== 0n) out.push({ name: "this", ...(await this.inspector!.present(self, "this")) });
    const locals = await visibleLocals(vm, frame);
    if (!locals) {
      out.push({ name: "(locals unavailable)", value: "compile with javac -g to see local variables", variablesReference: 0 });
      return out;
    }
    const values = await vm.frameValues(thread, frame.id, locals.map((l) => ({ slot: l.slot, tag: l.signature.charCodeAt(0) })));
    for (let i = 0; i < locals.length; i++) out.push({ name: locals[i].name, ...(await this.inspector!.present(values[i], locals[i].name, locals[i].signature)) });
    return out;
  }

  private async evaluate(expression: string, frameId: number | undefined, context?: string) {
    this.requireVm();
    let thread: bigint;
    let depth = 0;
    if (frameId !== undefined) ({ thread, depth } = this.frameRef(frameId));
    else if (this.stopped) thread = this.stopped.thread;
    else throw new UserError("The program is running: evaluation needs it paused at a breakpoint or step.");
    const ev = new Evaluator(this.evalContext(thread, depth));
    try {
      return this.presentResult(await ev.evaluate(expression), expression);
    } catch (e) {
      if (e instanceof EvalError || e instanceof UserError) throw e;
      throw new UserError(`${context === "hover" ? "" : "Cannot evaluate: "}${(e as Error).message}`);
    }
  }

  private async presentResult(v: Val, evaluateName: string) {
    switch (v.k) {
      case "prim":
        return { result: formatPrim(v), type: simpleTypeName(v.t), variablesReference: 0 };
      case "str":
        return { result: quoteString(v.v), type: "String", variablesReference: 0 };
      case "void":
        return { result: "(void)", variablesReference: 0 };
      case "class":
        return { result: qualifiedTypeName(v.sig), type: "Class", variablesReference: 0 };
      case "obj": {
        const p = await this.inspector!.present({ tag: v.tag, value: v.id }, evaluateName);
        return { result: p.value, type: p.type, variablesReference: p.variablesReference, indexedVariables: p.indexedVariables };
      }
    }
  }

  private async setVariable(ref: number, name: string, valueExpr: string) {
    const vm = this.requireVm();
    const spec = this.varHandles.lookup(ref);
    if (!spec) throw new UserError(`Unknown variables reference ${ref}.`);
    let thread = this.stopped?.thread;
    let depth = 0;
    if (spec.kind === "locals") ({ thread, depth } = this.frameRef(spec.frameRef));
    if (thread === undefined) throw new UserError("Pause the program to change variables.");
    const ev = new Evaluator(this.evalContext(thread, depth));
    const newValue = await ev.evaluate(valueExpr);
    let written: Value;
    let declared: string | undefined;
    if (spec.kind === "locals") {
      const frame = await this.frameAt(thread, depth);
      const local = (await visibleLocals(vm, frame))?.find((l) => l.name === name);
      if (!local) throw new UserError(`Cannot change ${name}.`);
      declared = local.signature;
      written = await ev.coerce(newValue, local.signature);
      await vm.setFrameValue(thread, (await this.frameAt(thread, depth)).id, local.slot, written);
    } else if (spec.kind === "statics") {
      const f = (await vm.fields(spec.classId)).find((x) => x.name === name);
      if (!f) throw new UserError(`Cannot change ${name}.`);
      declared = f.signature;
      written = await ev.coerce(newValue, f.signature);
      await vm.setStaticValue(spec.classId, f.id, written);
    } else if (spec.kind === "array" || /^\[\d+\]$/.test(name)) {
      const id = spec.id;
      const index = Number(/^\[(\d+)\]$/.exec(name)?.[1] ?? NaN);
      const sig = await vm.signature((await vm.objectType(id)).id);
      if (!sig.startsWith("[") || Number.isNaN(index)) throw new UserError(`Cannot change ${name}.`);
      declared = sig.slice(1);
      written = await ev.coerce(newValue, declared);
      await vm.setArrayValue(id, index, written);
    } else {
      const type = await vm.objectType(spec.id);
      // "tag (Base)" names the field `tag` declared by the superclass Base (it is shadowed).
      const shadow = /^(\S+) \((.+)\)$/.exec(name);
      let f = shadow ? undefined : await findField(vm, type.id, name);
      if (shadow) {
        for (const c of await vm.hierarchy(type.id)) {
          if (simpleTypeName(await vm.signature(c)).split("$").pop() !== shadow[2]) continue;
          f = (await vm.fields(c)).find((x) => x.name === shadow[1]);
          if (f) break;
        }
      }
      if (!f) throw new UserError(`Cannot change ${name}.`);
      declared = f.signature;
      written = await ev.coerce(newValue, f.signature);
      if (f.modifiers & ACC_STATIC) await vm.setStaticValue(f.owner, f.id, written);
      else await vm.setObjectValue(spec.id, f.id, written);
    }
    const p = await this.inspector!.present(written, undefined, declared);
    return { value: p.value, type: p.type, variablesReference: p.variablesReference, indexedVariables: p.indexedVariables };
  }
}

function capabilities() {
  return {
    supportsConfigurationDoneRequest: true,
    supportsConditionalBreakpoints: true,
    supportsHitConditionalBreakpoints: true,
    supportsLogPoints: true,
    supportsEvaluateForHovers: true,
    supportsSetVariable: true,
    supportsTerminateRequest: true,
    supportTerminateDebuggee: true,
    supportsExceptionInfoRequest: true,
    supportsDelayedStackTraceLoading: true,
    exceptionBreakpointFilters: [
      { filter: "uncaught", label: "Uncaught Exceptions", description: "Stop when an exception is not caught (the program would crash).", default: true },
      { filter: "caught", label: "Caught Exceptions", description: "Stop when your code throws an exception, even if a catch block handles it.", default: false },
    ],
  };
}

/** "Lcom/example/Util$Inner;" -> "com/example". */
function classPackageDir(signature: string): string {
  const name = signature.slice(1, -1);
  const slash = name.lastIndexOf("/");
  return slash < 0 ? "" : name.slice(0, slash);
}

/** VS Code hit conditions: "5", "== 5", ">= 5", "> 5", "< 5", "<= 5", "% 5". */
export function hitConditionMet(cond: string, hits: number): boolean {
  const m = /^\s*(==|>=|<=|>|<|%)?\s*(\d+)\s*$/.exec(cond);
  if (!m) return true;
  const n = Number(m[2]);
  switch (m[1]) {
    case ">=":
      return hits >= n;
    case ">":
      return hits > n;
    case "<=":
      return hits <= n;
    case "<":
      return hits < n;
    case "%":
      return n > 0 && hits % n === 0;
    default:
      return hits === n;
  }
}

function splitArgs(v: string[] | string | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(v); m; m = re.exec(v)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
