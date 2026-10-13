/**
 * Task Mentor's code runner (CODE_RUNNER_PLAN.md v3, docs/PROTOCOL.md §5): runs a student's files on
 * Task Mentor when this computer can't (the language's tools are missing, the browser build, an exam
 * machine without the tool). Signed in, it uses `/api/tmcode/code/*` with the TMCode user token; in an
 * exam, `/api/tmcode/sessions/:sid/code/*` with the exam's own token. Every feature is gated on
 * `GET …/capabilities`: no answer (an older Task Mentor), or a capability that is off, means TMCode
 * keeps to what it did before.
 */
import type { TestResult } from "@nga/runtimes/testing";

export interface CodeCapabilities {
  /** Live runs with keyboard input (`POST …/sessions`). */
  interactive: boolean;
  /** A real terminal (colours, Ctrl+C reaching the program). */
  pty: boolean;
  /** Unit tests (`POST …/test`) for `unit_test_languages`. */
  unit_tests: boolean;
  unit_test_languages: string[];
  previews: boolean;
}

export interface CodeFile {
  path: string;
  content: string;
}

/** One I/O test's result (`/code/run`). */
export interface ServerTest {
  id: string;
  verdict: string;
  passed: boolean | null;
  stdout: string;
  stderr: string;
  time_ms?: number | null;
}

/** A unit-test run's report (`/code/test`): `tests` has the `@nga/runtimes` TestResult shape. */
export interface UnitReport {
  framework: string | null;
  /** passed | failed | error | time-limit | memory-limit | package-not-available | internal-error */
  verdict: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  time_ms: number | null;
  output: string;
  truncated: boolean;
  tests: TestResult[];
}

export interface RunData {
  language: string;
  entry: string | null;
  kind: string | null;
  files_sent: string[];
  compile: { ok?: boolean; output?: string; verdict?: string } | null;
  tests: ServerTest[];
  unit: UnitReport | null;
  error: string | null;
}

export type SessionEvent =
  | { type: "stage"; name: "build" | "run" }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; signal: string | null; verdict: string; time_ms: number | null; memory_kb: number | null }
  | { type: "error"; message: string };

export class CodeRunnerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Where requests go: signed in (`account`) or in an exam (`exam`). Paths are relative to the code API. */
export interface CodeTransport {
  where: "account" | "exam";
  /** JSON request; resolves with the answer's body, throws CodeRunnerError. */
  call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** A body that keeps coming (Server-Sent Events). Null when this transport can't stream. */
  stream(path: string, on: { status?(status: number): void; data(text: string): void; end(error?: string): void }): { cancel(): void } | null;
}

// ───────────── which transport ─────────────

let examTransport: (() => CodeTransport | null) | null = null;
let accountTransport: (() => CodeTransport | null) | null = null;

/** Set by the exam session: its transport while an exam is running, else null. */
export function setExamCodeTransport(get: (() => CodeTransport | null) | null) {
  examTransport = get;
  caps.clear();
}

/** Set by the projects service: the signed-in transport, or null when signed out. */
export function setAccountCodeTransport(get: (() => CodeTransport | null) | null) {
  accountTransport = get;
  caps.clear();
}

/** The exam's transport during an exam (never the account's: exam rules), else the account's. */
export function codeTransport(): CodeTransport | null {
  return examTransport?.() ?? accountTransport?.() ?? null;
}

// ───────────── capabilities ─────────────

const CAPS_TTL_MS = 60_000;
const caps = new Map<string, { at: number; value: Promise<CodeCapabilities | null> }>();

/** Task Mentor's code runner capabilities (cached a minute). Null: none (an older Task Mentor, offline, signed out). */
export function capabilities(t: CodeTransport | null = codeTransport(), refresh = false): Promise<CodeCapabilities | null> {
  if (!t) return Promise.resolve(null);
  const hit = caps.get(t.where);
  if (hit && !refresh && Date.now() - hit.at < CAPS_TTL_MS) return hit.value;
  const value = t
    .call<CodeCapabilities | { data?: CodeCapabilities }>("GET", "/capabilities")
    .then((raw) => normalizeCapabilities(raw))
    .catch(() => null);
  caps.set(t.where, { at: Date.now(), value });
  // A failed answer is not kept: the next call asks again.
  void value.then((v) => v === null && caps.get(t.where)?.value === value && caps.delete(t.where));
  return value;
}

export function normalizeCapabilities(raw: unknown): CodeCapabilities | null {
  const r = unwrap(raw) as Partial<CodeCapabilities> | null;
  if (!r || typeof r !== "object") return null;
  return {
    interactive: r.interactive === true,
    pty: r.pty === true,
    unit_tests: r.unit_tests === true,
    unit_test_languages: Array.isArray(r.unit_test_languages) ? r.unit_test_languages.filter((x): x is string => typeof x === "string") : [],
    previews: r.previews === true,
  };
}

/** Whether the runner runs `language`'s unit tests (any, when it doesn't list them). */
export function runsUnitTests(c: CodeCapabilities | null, language: string | null | undefined): boolean {
  if (!c?.unit_tests) return false;
  if (!language || !c.unit_test_languages.length) return true;
  return c.unit_test_languages.includes(language);
}

/** `{ success, data }` (the code API) or the bare object (the exam API). */
export function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "data" in raw && ("success" in raw || Object.keys(raw).length === 1)) return (raw as { data: T }).data;
  return raw as T;
}

// ───────────── runs and tests ─────────────

export interface RunRequestBody {
  language?: string | null;
  kind?: string | null;
  entry?: string | null;
  files: CodeFile[];
}

/** Runs `files` once per test (practice: the example tests of `.nga/tests.json`). */
export async function runOnServer(t: CodeTransport, body: RunRequestBody & { tests: { id: string; input: string; expected_output?: string | null }[] }): Promise<RunData> {
  return normalizeRun(unwrap(await t.call("POST", "/run", body)));
}

/** Runs the project's unit tests (pytest, JUnit, node:test, go test…). */
export async function unitTestsOnServer(t: CodeTransport, body: { language?: string | null; kind?: string | null; test_filter?: string | null; files: CodeFile[]; question_id?: number }): Promise<RunData> {
  return normalizeRun(unwrap(await t.call("POST", "/test", body)));
}

function normalizeRun(raw: unknown): RunData {
  const r = (raw ?? {}) as Partial<RunData>;
  return {
    language: String(r.language ?? ""),
    entry: r.entry ?? null,
    kind: r.kind ?? null,
    files_sent: Array.isArray(r.files_sent) ? r.files_sent : [],
    compile: r.compile ?? null,
    tests: Array.isArray(r.tests) ? r.tests : [],
    unit: r.unit ? { ...r.unit, tests: Array.isArray(r.unit.tests) ? r.unit.tests : [] } : null,
    error: r.error ?? null,
  };
}

// ───────────── live runs (sessions) ─────────────

/**
 * Parses a Server-Sent Events body as it arrives (`event: <name>\ndata: <json>\n\n`, `: ping`
 * comments ignored). Pieces may split anywhere, even inside a line.
 */
export function sseParser(on: (e: SessionEvent) => void) {
  let buf = "";
  return (text: string) => {
    buf += text.replace(/\r\n?/g, "\n");
    for (let cut = buf.indexOf("\n\n"); cut >= 0; cut = buf.indexOf("\n\n")) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
      if (!data.length) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(data.join("\n"));
      } catch {
        continue;
      }
      const e = toEvent(name, d);
      if (e) on(e);
    }
  };
}

function toEvent(name: string, d: Record<string, unknown>): SessionEvent | null {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  switch (name) {
    case "stage":
      return d.name === "build" || d.name === "run" ? { type: "stage", name: d.name } : null;
    case "stdout":
    case "stderr":
      return { type: name, data: String(d.data ?? "") };
    case "exit":
      return { type: "exit", code: num(d.code), signal: typeof d.signal === "string" ? d.signal : null, verdict: String(d.verdict ?? (d.code === 0 ? "ok" : "runtime-error")), time_ms: num(d.time_ms), memory_kb: num(d.memory_kb) };
    case "error":
      return { type: "error", message: String(d.message ?? "The run stopped.") };
    default:
      return null;
  }
}

export interface RemoteSession {
  id: string;
  /** A line (or any text) for the program's input. */
  input(data: string): Promise<void>;
  /** End of input (the program reads EOF). */
  eof(): Promise<void>;
  /** Ctrl+C. */
  interrupt(): Promise<void>;
  /** Stops the program and the stream. */
  stop(): Promise<void>;
}

/**
 * Starts a live run on Task Mentor and streams its events to `onEvent` until `exit` (always last,
 * synthesized when the stream breaks). Throws CodeRunnerError when it can't start.
 */
export async function startSession(t: CodeTransport, body: RunRequestBody, onEvent: (e: SessionEvent) => void): Promise<RemoteSession> {
  const started = unwrap<{ id?: string }>(await t.call("POST", "/sessions", { ...body, pty: false }));
  const id = started?.id;
  if (!id) throw new CodeRunnerError(0, "SESSION_FAILED", "Task Mentor did not start the run.");
  let ended = false;
  const send = (e: SessionEvent) => {
    if (ended) return;
    if (e.type === "exit") ended = true;
    onEvent(e);
  };
  const parse = sseParser(send);
  const path = `/sessions/${encodeURIComponent(id)}`;
  const stream = t.stream(`${path}/events`, {
    status(status) {
      if (status >= 400) {
        send({ type: "error", message: status === 404 ? "The run has already ended on Task Mentor." : `Task Mentor could not stream the run (${status}).` });
      }
    },
    data: parse,
    end(error) {
      if (ended) return;
      if (error) send({ type: "error", message: `The connection to Task Mentor broke: ${error}` });
      send({ type: "exit", code: null, signal: null, verdict: "internal-error", time_ms: null, memory_kb: null });
    },
  });
  if (!stream) {
    void t.call("DELETE", path).catch(() => {});
    throw new CodeRunnerError(0, "NO_STREAM", "Live runs on Task Mentor need the TMCode desktop app.");
  }
  const post = (b: Record<string, unknown>) => (ended ? Promise.resolve() : t.call<void>("POST", `${path}/input`, b).then(() => undefined));
  return {
    id,
    input: (data) => post({ data }),
    eof: () => post({ eof: true }),
    interrupt: () => post({ signal: "SIGINT" }),
    async stop() {
      if (ended) return;
      await t.call("DELETE", path).catch(() => {});
      // The stream ends with the program's exit; if it doesn't come, stop listening anyway.
      setTimeout(() => {
        if (ended) return;
        stream.cancel();
        send({ type: "exit", code: null, signal: "SIGTERM", verdict: "runtime-error", time_ms: null, memory_kb: null });
      }, 3000);
    },
  };
}

// ───────────── plain words ─────────────

/** What a runner verdict means, in the words the Testing view uses. */
export function verdictWords(verdict: string | null | undefined): string | null {
  switch (verdict) {
    case undefined:
    case null:
    case "":
      return null;
    case "accepted":
    case "ok":
    case "passed":
      return "Passed";
    case "wrong-answer":
    case "failed":
      return "Wrong answer";
    case "runtime-error":
      return "Crashed (runtime error)";
    case "compile-error":
    case "error":
      return "Did not compile";
    case "time-limit":
      return "Too slow (time limit)";
    case "memory-limit":
      return "Used too much memory";
    case "output-limit":
      return "Printed too much";
    case "package-not-available":
      return "Uses a package the code runner doesn't have";
    case "internal-error":
      return "Task Mentor could not run it";
    default:
      return verdict;
  }
}

/**
 * The status colour of a verdict: green passed, red the program's own fault (wrong answer, crash,
 * didn't compile), orange a limit or something it can't fix in the code alone, blue information.
 */
export type VerdictTone = "passed" | "failed" | "limit" | "info";

export function verdictTone(verdict: string | null | undefined): VerdictTone {
  switch (verdict) {
    case "accepted":
    case "ok":
    case "passed":
      return "passed";
    case "wrong-answer":
    case "failed":
    case "runtime-error":
    case "compile-error":
    case "error":
      return "failed";
    case "time-limit":
    case "memory-limit":
    case "output-limit":
    case "package-not-available":
    case "internal-error":
      return "limit";
    default:
      return "info";
  }
}

/** Plain words for a code-runner error code. */
export function codeErrorWords(e: unknown): string {
  const err = e as Partial<CodeRunnerError> | null;
  switch (err?.code) {
    case "RATE_LIMITED":
    case "TOO_MANY_REQUESTS":
      return "Too many runs on Task Mentor. Wait a minute, then run again.";
    case "JUDGE_UNAVAILABLE":
    case "QUOTA_EXCEEDED":
    case "BUSY":
    case "RUNNER_BUSY":
    case "RUNNER_UNAVAILABLE":
      return "Task Mentor's code runner is busy. Try again in a moment.";
    case "INTERACTIVE_UNAVAILABLE":
      return "Task Mentor can't run programs live right now.";
    case "SESSION_ENDED":
    case "SESSION_NOT_FOUND":
      return "The run has already ended.";
    case "SESSION_SUPERSEDED":
      return "This exam is open on another computer.";
    case "UNIT_TESTS_UNAVAILABLE":
      return "Task Mentor can't run unit tests yet.";
    case "NO_UNIT_TESTS":
      return "Task Mentor doesn't know how to run this project's unit tests.";
    case "UNSUPPORTED_LANGUAGE":
    case "NOTHING_TO_RUN":
    case "TOO_LARGE":
      return err.message ?? "Task Mentor can't run this.";
    case "OFFLINE":
      return "Task Mentor can't be reached. Check your connection.";
    default:
      if (err?.status === 0) return "Task Mentor can't be reached. Check your connection.";
      return err?.message || "The run on Task Mentor failed. Try again.";
  }
}
