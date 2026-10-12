/**
 * Interactive sessions (CODE_RUNNER_PLAN §16, docs/PROTOCOL.md "Sessions"):
 * build like a batch run, then run the program with live pipes (no PTY) and
 * stream its output as server-sent events while stdin arrives over HTTP.
 *
 *   POST   /v1/sessions               {language?, kind?, files, entry?, limits?} → 201 {id}
 *   GET    /v1/sessions/:id/events    text/event-stream: stage, stdout, stderr, exit, error
 *   POST   /v1/sessions/:id/stdin     {data} → 204
 *   POST   /v1/sessions/:id/eof       → 204
 *   POST   /v1/sessions/:id/signal    {name: "SIGINT"|"SIGTERM"} → 204
 *   POST   /v1/sessions/:id/resize    {cols, rows} → 204 (PTY sessions)
 *   DELETE /v1/sessions/:id           → 204
 *
 * `pty: true` (tier 3) runs the program in a container with a real terminal
 * (Docker attach, Tty): raw output (ANSI included) arrives as `stdout`
 * events, signals reach the program, and the terminal can be resized.
 * Without it, the isolate pipes path is unchanged.
 *
 * Limits: the batch run's (memory, processes, CPU time), a 10-minute wall
 * clock, a 2-minute idle timeout (no stdin and no output), 1 MB of
 * stdout+stderr. The box is cleaned up on exit, DELETE or when the event
 * stream disconnects.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { capBytes, RequestError, STDERR_CAP, transpileTypeScript, validateFiles, VERDICT, type RunLimits, type SubmissionFile, type Verdict } from "./judge.ts";
import { javaMainClass, languageById, type Ctx } from "./languages.ts";
import { missingPackage, missingPackageMessage } from "./packages.ts";
import { boxSetup, buildLimits, cacheFiles, isProfileRequest, mainClassOf, placement, PROFILE_KINDS, quiet, resolveProject, runLimits, startServices, stepArgv, stepFailureText, type ProjectRequest } from "./project.ts";
import { DEFAULT_TTY, type ContainerSandbox } from "./containers.ts";
import { ServiceError, type ServiceHandle, type ServiceName } from "./services.ts";
import type { AcquireOptions, Box, ExecResult, Limits, Proc, Sandbox, SessionSignal } from "./sandbox.ts";
import { testFilterArgs, type TokenContext } from "./tokens.ts";
import type { Toolchains } from "./toolchains.ts";

export interface SessionRequest {
  language?: string;
  kind?: string;
  files: SubmissionFile[];
  entry?: string;
  limits?: Partial<RunLimits>;
  /** A real terminal (tier 3): container kinds, or any kind whose runtime has a container image. */
  pty?: boolean;
  /** Initial terminal size (PTY), default 120×30. */
  cols?: number;
  rows?: number;
  /** A database sidecar for the program (tier 3), as in /v1/run. */
  services?: string[];
}

export type SessionEvent =
  | { event: "stage"; data: { name: "build" | "run" } }
  | { event: "stdout"; data: { data: string } }
  | { event: "stderr"; data: { data: string } }
  | { event: "exit"; data: { code: number | null; signal: string | null; verdict: Verdict; time_ms: number; memory_kb: number | null } }
  | { event: "error"; data: { message: string } };

export interface SessionOptions {
  /** Concurrent sessions (JUDGE_SESSIONS, default 4). */
  max?: number;
  wallMs?: number;
  idleMs?: number;
  outputBytes?: number;
  /** How long a finished session's events stay readable (late subscribers). */
  keepMs?: number;
}

export function sessionError(status: number, code: string, message: string) {
  return Object.assign(new RequestError(message), { status, code });
}

/** What a session runs: an optional build, then one program. */
interface Plan {
  acquire: AcquireOptions;
  files: SubmissionFile[];
  /** Returns null when the build succeeded, else the failure to report. */
  build: ((box: Box) => Promise<{ output: string; verdict: Verdict; code: number | null; timeMs: number } | null>) | null;
  argv: (box: Box) => string[];
  env: Record<string, string>;
  limits: Limits;
  /** Tier 3: the container sandbox (else the session sandbox). */
  sandbox?: Sandbox;
  services?: ServiceName[];
  tty?: { cols: number; rows: number };
}

const STDBUF = "/usr/bin/stdbuf";

/** Profile requests (python-3, c17…): the batch judge's compile and run commands. */
function profilePlan(req: SessionRequest, programs: Map<string, string>): Plan {
  const lang = languageById(req.language!)!;
  validateFiles(req.files);
  if (!req.entry || !req.files.some((f) => f.path === req.entry)) throw new RequestError(`Entry '${req.entry ?? ""}' is not among the files.`);
  const missing = lang.programs.filter((p) => !programs.has(p));
  if (missing.length) throw sessionError(503, "RUNTIME_UNAVAILABLE", `The judge has no ${missing.join(", ")} installed.`);
  const entry = req.entry;
  const stem = entry.split("/").pop()!.replace(/\.[^.]+$/, "");
  const ctx: Ctx = {
    entry,
    entryStem: stem,
    mainClass: javaMainClass(stem, String(req.files.find((f) => f.path === entry)?.content ?? "")),
    sources: (ext) => req.files.map((f) => f.path).filter((p) => p.toLowerCase().endsWith(`.${ext}`)),
    bin: (p) => programs.get(p) ?? p,
  };
  const limits: Limits = {
    cpuS: Math.min(req.limits?.time_s ?? 5, 20),
    wallS: 10,
    memoryMb: Math.min(Math.max(req.limits?.memory_mb ?? 256, lang.memoryMb ?? 0), 1024),
    processes: lang.processes ?? 16,
    outputKb: 1024,
  };
  const build =
    lang.transpile || lang.compile
      ? async (box: Box) => {
          if (lang.transpile === "typescript") {
            const t = await transpileTypeScript(req.files);
            for (const f of t.files) await box.write(f.path, f.content);
            if (t.errors.length) return { output: t.errors.join("\n"), verdict: "compile-error" as Verdict, code: 1, timeMs: t.timeMs };
          }
          if (lang.compile) {
            const c = await box.exec(lang.compile(ctx), { stdin: "", limits: { cpuS: 20, wallS: 30, memoryMb: 768, processes: 64, outputKb: 256 }, env: lang.env });
            if (c.status !== "ok" || c.exitCode !== 0) return { output: `${c.stdout}${c.stderr}` || "Compilation failed", verdict: "compile-error" as Verdict, code: c.exitCode, timeMs: c.timeMs };
          }
          return null;
        }
      : null;
  // Compiled programs see a pipe, not a terminal: line-buffer them so prompts appear.
  const lineBuffered = !!lang.compile && existsSync(STDBUF);
  return {
    acquire: {},
    files: req.files,
    build,
    argv: () => (lineBuffered ? [STDBUF, "-oL", "-eL", ...lang.run(ctx)] : lang.run(ctx)),
    env: lang.env ?? {},
    limits,
  };
}

/** Terminal size from a request: whole numbers within sane bounds. */
export function termSize(cols: unknown, rows: unknown, fallback = DEFAULT_TTY) {
  const c = cols === undefined ? fallback.cols : Number(cols);
  const r = rows === undefined ? fallback.rows : Number(rows);
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 10 || c > 500 || r < 2 || r > 200) throw new RequestError("cols must be 10–500 and rows 2–200.");
  return { cols: c, rows: r };
}

/** Catalog kinds: restore + build steps, then the kind's run step. */
function kindPlan(req: SessionRequest, toolchains: Toolchains, containers?: ContainerSandbox): Plan {
  const resolved = resolveProject(toolchains, { ...(req as ProjectRequest), actions: ["run"], tests: [] }, req.pty ? { container: "pty" } : {});
  const { kind, entry } = resolved;
  const where = placement(containers as unknown as Sandbox, { toolchains, containers }, resolved);
  const tc = where.toolchains;
  const setup = boxSetup(tc, kind);
  const ctx: TokenContext = { entry: entry ?? "", files: req.files.map((f) => f.path), mainClass: mainClassOf(entry, req.files), testFilter: testFilterArgs("", null), reportPath: null };
  const exists = (p: string) => req.files.some((f) => f.path === p);
  const steps = (["restore", "build"] as const).map((n) => [n, kind.steps[n]] as const).filter(([, s]) => s && (!s.when || s.when.exists.every(exists)));
  const run = kind.steps.run!;
  return {
    acquire: { mounts: setup.mounts, dirs: setup.dirs, image: where.image },
    sandbox: where.image ? where.sandbox : undefined,
    services: resolved.services,
    tty: req.pty ? termSize(req.cols, req.rows) : undefined,
    files: req.files,
    build: steps.length
      ? async (box: Box) => {
          for (const f of cacheFiles(kind, setup.mounts, box, req.files)) await box.write(f.path, f.content);
          let ms = 0;
          for (const [name, s] of steps) {
            const limits = buildLimits(kind, name);
            const r = quiet(await box.exec(stepArgv(tc, kind, s!, ctx), { stdin: "", limits, env: { ...setup.env, ...(s!.env ?? {}) }, cwd: s!.cwd }));
            ms += r.timeMs;
            if (r.status !== "ok" || r.exitCode !== 0) {
              const m = missingPackage(`${r.stdout}\n${r.stderr}`);
              const text = stepFailureText(name, r, limits);
              return { output: m ? `${missingPackageMessage(m)}\n\n${text}` : text, verdict: (m ? "package-not-available" : "compile-error") as Verdict, code: r.exitCode, timeMs: ms };
            }
          }
          return null;
        }
      : null,
    argv: () => stepArgv(tc, kind, run, ctx),
    env: { ...setup.env, ...(run.env ?? {}) },
    limits: runLimits(kind, req.limits),
  };
}

class Session {
  readonly id = randomUUID();
  readonly events: SessionEvent[] = [];
  readonly listeners = new Set<(e: SessionEvent) => void>();
  ended = false;
  proc: Proc | null = null;
  box: Box | null = null;
  /** stdin that arrived before the program started. */
  pending: (string | null)[] = [];
  pendingSignal: SessionSignal | null = null;
  /** A signal the client sent (SIGINT/SIGTERM). */
  userSignal: string | null = null;
  /** PTY: the terminal size (a resize before the program starts is kept here). */
  tty: { cols: number; rows: number } | null = null;
  db: ServiceHandle | null = null;
  /** Why the judge stopped the program (decides the verdict). */
  stopped: { verdict: Verdict; signal: string | null } | null = null;
  outputBytes = 0;
  timers: NodeJS.Timeout[] = [];
  idle: NodeJS.Timeout | null = null;

  emit(e: SessionEvent) {
    if (this.ended) return;
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private live = 0;
  readonly max: number;
  private wallMs: number;
  private idleMs: number;
  private outputCap: number;
  private keepMs: number;
  private sandbox: Sandbox;
  private programs: Map<string, string>;
  private toolchains: Toolchains;
  private containers?: ContainerSandbox;

  constructor(sandbox: Sandbox, programs: Map<string, string>, toolchains: Toolchains, opts: SessionOptions = {}, containers?: ContainerSandbox) {
    this.sandbox = sandbox;
    this.containers = containers;
    this.programs = programs;
    this.toolchains = toolchains;
    this.max = opts.max ?? 4;
    this.wallMs = opts.wallMs ?? 10 * 60_000;
    this.idleMs = opts.idleMs ?? 2 * 60_000;
    this.outputCap = opts.outputBytes ?? 1024 * 1024;
    this.keepMs = opts.keepMs ?? 60_000;
  }

  get running() {
    return this.live;
  }

  /** Validates, reserves a slot and starts building; events are buffered until someone listens. */
  create(body: unknown): { id: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object.");
    const req = body as SessionRequest;
    if (this.live >= this.max) throw sessionError(429, "BUSY", `At most ${this.max} interactive sessions at a time. Try again shortly.`);
    if (req.pty !== undefined && typeof req.pty !== "boolean") throw new RequestError("pty must be true or false.");
    const containerized = !!req.pty || (Array.isArray(req.services) && req.services.length > 0);
    if (req.pty && (!this.containers || !this.toolchains.containers?.status.usable)) throw sessionError(409, "PTY_UNAVAILABLE", "This runner has no container tier, so sessions can't get a terminal; run without pty.");
    // Terminals and databases run in a container: a profile request runs as its single-file kind there.
    const asKind = containerized && isProfileRequest(req) ? { ...req, kind: PROFILE_KINDS[req.language!], language: undefined } : req;
    const plan = isProfileRequest(asKind) ? profilePlan(asKind, this.programs) : kindPlan(asKind, this.toolchains, this.containers);
    const s = new Session();
    s.tty = plan.tty ?? null;
    this.sessions.set(s.id, s);
    this.live++;
    s.timers.push(setTimeout(() => this.stop(s, "time-limit", `The session reached its ${Math.round(this.wallMs / 60_000)}-minute limit.`), this.wallMs));
    void this.start(s, plan);
    return { id: s.id };
  }

  get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw sessionError(404, "NOT_FOUND", "No such session.");
    return s;
  }

  private async start(s: Session, plan: Plan) {
    let done: ExecResult | null = null;
    try {
      if (plan.services?.length) {
        try {
          s.db = await startServices({ containers: this.containers }, plan.services, plan.files);
          await s.db?.fresh();
        } catch (e) {
          if (!(e instanceof ServiceError)) throw e;
          s.emit({ event: "stderr", data: { data: `${[e.message, e.output].filter(Boolean).join("\n")}\n` } });
          s.emit({ event: "exit", data: { code: null, signal: null, verdict: "compile-error", time_ms: 0, memory_kb: null } });
          return;
        }
        if (s.ended) return;
      }
      s.box = await (plan.sandbox ?? this.sandbox).acquire({ ...plan.acquire, network: s.db?.network });
      if (s.ended) return;
      for (const f of plan.files) await s.box.write(f.path, f.content);
      if (plan.build) {
        s.emit({ event: "stage", data: { name: "build" } });
        const failed = await plan.build(s.box);
        if (s.ended) return;
        if (failed) {
          const text = capBytes(failed.output.trim(), STDERR_CAP).text;
          if (text) s.emit({ event: "stderr", data: { data: `${text}\n` } });
          s.emit({ event: "exit", data: { code: failed.code, signal: null, verdict: failed.verdict, time_ms: failed.timeMs, memory_kb: null } });
          return;
        }
      }
      if (s.ended) return;
      s.emit({ event: "stage", data: { name: "run" } });
      const proc = s.box.spawn(plan.argv(s.box), { limits: { ...plan.limits, wallS: Math.ceil(this.wallMs / 1000) }, env: { ...plan.env, ...(s.db?.env ?? {}), ...(s.tty ? { TERM: "xterm-256color", COLUMNS: String(s.tty.cols), LINES: String(s.tty.rows) } : {}) }, tty: s.tty ?? undefined });
      s.proc = proc;
      this.touch(s);
      const pipe = (event: "stdout" | "stderr") => {
        const decoder = new StringDecoder("utf8");
        return (chunk: Buffer) => {
          if (s.stopped || s.ended) return;
          this.touch(s);
          const left = this.outputCap - s.outputBytes;
          const part = chunk.length > left ? chunk.subarray(0, Math.max(left, 0)) : chunk;
          s.outputBytes += part.length;
          const text = decoder.write(part);
          if (text) s.emit({ event, data: { data: text } });
          if (chunk.length > left) this.stop(s, "output-limit", `The program printed more than ${Math.round(this.outputCap / 1024 / 1024)} MB; it was stopped.`);
        };
      };
      proc.onStdout(pipe("stdout"));
      proc.onStderr(pipe("stderr"));
      for (const d of s.pending.splice(0)) (d === null ? proc.end() : proc.write(d));
      if (s.pendingSignal) proc.kill(s.pendingSignal);
      done = await proc.done;
      let verdict = VERDICT[done.status];
      if (verdict === "ok" && done.exitCode !== 0) verdict = "runtime-error";
      if (s.stopped) verdict = s.stopped.verdict;
      // isolate ends the box itself when it gets the client's signal.
      else if (s.userSignal && verdict === "internal-error") verdict = "runtime-error";
      const signal = /Killed by (SIG\w+)/.exec(done.message ?? "")?.[1] ?? s.stopped?.signal ?? s.userSignal ?? (done.status === "signal" ? "SIGKILL" : null);
      s.emit({ event: "exit", data: { code: done.exitCode, signal, verdict, time_ms: done.timeMs, memory_kb: done.memoryKb } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      s.emit({ event: "error", data: { message } });
      s.emit({ event: "exit", data: { code: null, signal: null, verdict: "internal-error", time_ms: 0, memory_kb: null } });
    } finally {
      await this.finish(s);
    }
  }

  /** Resets the idle timer (stdin or output). */
  private touch(s: Session) {
    if (s.idle) clearTimeout(s.idle);
    if (s.ended) return;
    s.idle = setTimeout(() => this.stop(s, "time-limit", `No input or output for ${Math.round(this.idleMs / 1000)} s; the session was closed.`), this.idleMs);
  }

  /** The judge stops the program: an error event, then it is killed (exit follows). */
  private stop(s: Session, verdict: Verdict, message: string) {
    if (s.ended || s.stopped) return;
    s.stopped = { verdict, signal: "SIGKILL" };
    s.emit({ event: "error", data: { message } });
    if (s.proc) s.proc.kill("SIGKILL");
    else {
      // Still building: end it here (start() sees `ended` and returns).
      s.emit({ event: "exit", data: { code: null, signal: null, verdict, time_ms: 0, memory_kb: null } });
      void this.finish(s);
    }
  }

  private async finish(s: Session) {
    if (s.ended) return;
    s.ended = true;
    for (const t of s.timers) clearTimeout(t);
    if (s.idle) clearTimeout(s.idle);
    s.proc?.kill("SIGKILL");
    s.listeners.clear();
    this.live--;
    const box = s.box;
    s.box = null;
    if (box) await box.dispose().catch(() => {});
    const db = s.db;
    s.db = null;
    if (db) await db.dispose().catch(() => {});
    // Late subscribers can still read the events for a while.
    const t = setTimeout(() => this.sessions.delete(s.id), this.keepMs);
    t.unref();
  }

  stdin(id: string, body: unknown) {
    const s = this.get(id);
    const data = (body as { data?: unknown })?.data;
    if (typeof data !== "string") throw new RequestError("stdin needs { data: string }.");
    if (Buffer.byteLength(data) > 64 * 1024) throw new RequestError("At most 64 KB of stdin per request.");
    if (s.ended) throw sessionError(409, "SESSION_ENDED", "The program has ended.");
    if (s.proc) {
      this.touch(s);
      s.proc.write(data);
    } else s.pending.push(data);
  }

  eof(id: string) {
    const s = this.get(id);
    if (s.ended) throw sessionError(409, "SESSION_ENDED", "The program has ended.");
    if (s.proc) s.proc.end();
    else s.pending.push(null);
  }

  signal(id: string, body: unknown) {
    const s = this.get(id);
    const name = (body as { name?: unknown })?.name;
    if (name !== "SIGINT" && name !== "SIGTERM") throw new RequestError('signal needs { name: "SIGINT" | "SIGTERM" }.');
    if (s.ended) throw sessionError(409, "SESSION_ENDED", "The program has ended.");
    s.userSignal = name;
    if (s.proc) s.proc.kill(name);
    else s.pendingSignal = name;
  }

  /** PTY sessions: the terminal's new size. */
  resize(id: string, body: unknown) {
    const s = this.get(id);
    if (!s.tty) throw sessionError(409, "NOT_A_TERMINAL", "This session has no terminal (start it with pty: true).");
    const b = (body ?? {}) as { cols?: unknown; rows?: unknown };
    if (b.cols === undefined || b.rows === undefined) throw new RequestError("resize needs { cols, rows }.");
    const size = termSize(b.cols, b.rows);
    if (s.ended) throw sessionError(409, "SESSION_ENDED", "The program has ended.");
    s.tty = size;
    s.proc?.resize?.(size.cols, size.rows);
  }

  async remove(id: string) {
    const s = this.get(id);
    this.sessions.delete(id);
    if (!s.ended) {
      s.stopped ??= { verdict: "runtime-error", signal: "SIGKILL" };
      await this.finish(s);
    }
  }

  /** Streams a session's events (replaying earlier ones). Disconnecting stops a running session. */
  subscribe(id: string, res: ServerResponse) {
    const s = this.get(id);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const write = (e: SessionEvent) => res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    for (const e of s.events) write(e);
    if (s.ended) return void res.end();
    // Keeps proxies and client timeouts from closing a quiet stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    ping.unref();
    res.on("close", () => clearInterval(ping));
    const listener = (e: SessionEvent) => {
      write(e);
      if (e.event === "exit") {
        s.listeners.delete(listener);
        res.end();
      }
    };
    s.listeners.add(listener);
    // The response closing before the exit event = the client went away.
    res.on("close", () => {
      if (!s.listeners.has(listener)) return;
      s.listeners.delete(listener);
      if (!s.ended && s.listeners.size === 0) {
        s.stopped ??= { verdict: "runtime-error", signal: "SIGKILL" };
        void this.finish(s);
      }
    });
  }

  async closeAll() {
    for (const s of this.sessions.values()) await this.finish(s);
  }
}
