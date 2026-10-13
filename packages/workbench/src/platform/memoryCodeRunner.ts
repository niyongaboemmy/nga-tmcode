/**
 * Dev server / e2e only: Task Mentor's code runner (`/api/tmcode/code/*`, docs/PROTOCOL.md §5) in
 * memory. Programs don't really run; a small, predictable script stands in for them:
 *
 * - **Runs and example tests** (`POST /run`): a program passes (prints the expected output) unless
 *   its entry file contains `BUG` (prints `oops`) or `LOOP` (time limit).
 * - **Unit tests** (`POST /test`): every `def test_…` (Python), `test("…")`/`it("…")` (JavaScript)
 *   or `@Test void …()` (Java) is a test; it fails when its body has `assert False`, `FAIL` or
 *   `fail(`, with that line as file:line.
 * - **Live runs** (`/sessions`): asks "What is your name? ", answers "Hello, <name>!" to the first
 *   line and exits 0; End of Input prints "Bye" and exits 0; Ctrl+C ends it (SIGINT); `BUG` in the
 *   entry crashes it (stderr, exit 1). Events stream as real Server-Sent Events, in uneven pieces.
 *
 * Off until localStorage "tmcode:mock-code-runner" is "1" (an older Task Mentor: 404). Test hooks
 * on `window.__TMCODE_CODE__`: `setCapabilities(caps | null)`, `requests()` (what was sent),
 * `failNext(status, code)`.
 */
import type { TmStreamEvent } from "./types";

export interface FakeCaps {
  interactive: boolean;
  pty: boolean;
  unit_tests: boolean;
  unit_test_languages: string[];
  previews: boolean;
}

interface File {
  path: string;
  content: string;
}

interface Session {
  id: string;
  entry: string;
  crash: boolean;
  events: string[];
  ended: boolean;
  listeners: Set<(chunk: string | null) => void>;
  asked: boolean;
}

const DEFAULT_CAPS: FakeCaps = { interactive: true, pty: false, unit_tests: true, unit_test_languages: ["python", "javascript", "java"], previews: false };

export function unitResults(files: File[]) {
  const tests: { id: string; name: string; group: string; file: string; line: number; status: "passed" | "failed"; durationMs: number; message: string | null; details: string | null }[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    const starts: { name: string; line: number }[] = [];
    lines.forEach((l, i) => {
      const m = /^\s*def (test_\w+)\s*\(/.exec(l) ?? /^\s*(?:test|it)\(\s*["'`]([^"'`]+)["'`]/.exec(l) ?? (/@Test/.test(lines[i - 1] ?? "") ? /void (\w+)\s*\(/.exec(l) : null);
      if (m) starts.push({ name: m[1], line: i + 1 });
    });
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].line - 1 : lines.length;
      const bodyLines = lines.slice(s.line, end);
      const bad = bodyLines.findIndex((l) => /assert False|FAIL|fail\(/.test(l));
      tests.push({
        id: `${f.path}::${s.name}`,
        name: s.name,
        group: f.path.replace(/\.[^.]+$/, "").split("/").pop() ?? f.path,
        file: f.path,
        line: bad >= 0 ? s.line + 1 + bad : s.line,
        status: bad >= 0 ? "failed" : "passed",
        durationMs: 3,
        message: bad >= 0 ? `AssertionError: ${bodyLines[bad].trim()}` : null,
        details: bad >= 0 ? `${f.path}:${s.line + 1 + bad}: ${bodyLines[bad].trim()}` : null,
      });
    });
  }
  return tests;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createFakeCodeRunner() {
  // Off unless asked for (localStorage "tmcode:mock-code-runner" = "1", or setCapabilities): like an older Task Mentor.
  let caps: FakeCaps | null = (() => {
    try {
      return localStorage.getItem("tmcode:mock-code-runner") === "1" ? { ...DEFAULT_CAPS } : null;
    } catch {
      return null;
    }
  })();
  let failNext: { status: number; code: string } | null = null;
  const sent: { path: string; body: unknown }[] = [];
  const sessions = new Map<string, Session>();
  let seq = 0;

  const ok = (body: unknown, status = 200) => ({ status, body: { success: true, data: body } });
  const err = (status: number, code: string, message: string) => ({ status, body: { success: false, code, message } });

  function push(s: Session, chunk: string) {
    s.events.push(chunk);
    s.listeners.forEach((l) => l(chunk));
  }
  function end(s: Session, exit: Record<string, unknown>) {
    if (s.ended) return;
    push(s, sse("exit", { signal: null, time_ms: 40, memory_kb: 900, ...exit }));
    s.ended = true;
    s.listeners.forEach((l) => l(null));
  }

  function route(method: string, path: string, body: Record<string, unknown>): { status: number; body: unknown } {
    if (path !== "/capabilities") sent.push({ path, body });
    if (!caps) return { status: 404, body: { error_code: "NOT_FOUND", message: "Not found" } };
    if (failNext && path !== "/capabilities") {
      const f = failNext;
      failNext = null;
      return err(f.status, f.code, f.code === "RATE_LIMITED" ? "Too many runs." : "The code runner is busy or offline.");
    }
    const files = (body.files as File[] | undefined) ?? [];
    const entryOf = () => files.find((f) => f.path === body.entry) ?? files[0];
    if (path === "/capabilities" && method === "GET") return ok(caps);
    if (path === "/run" && method === "POST") {
      const entry = entryOf();
      const tests = (body.tests as { id: string; input: string; expected_output?: string | null }[]) ?? [];
      const bug = !!entry?.content.includes("BUG");
      const loop = !!entry?.content.includes("LOOP");
      return ok({
        engine: "fake",
        language: body.language ?? "python",
        entry: entry?.path ?? null,
        kind: body.kind ?? null,
        files_sent: files.map((f) => f.path),
        compile: null,
        tests: tests.map((t) => {
          const stdout = loop ? "" : bug ? "oops\n" : (t.expected_output ?? "Hello, NGA!\n");
          const passed = t.expected_output == null ? null : !bug && !loop;
          return { id: t.id, verdict: loop ? "time-limit" : bug && t.expected_output != null ? "wrong-answer" : "accepted", passed, stdout, stderr: "", time_ms: loop ? 5000 : 12 };
        }),
        unit: null,
        error: null,
      });
    }
    if (path === "/test" && method === "POST") {
      if (!caps.unit_tests) return err(409, "UNIT_TESTS_UNAVAILABLE", "Unit tests can't run here yet: use the input/output tests.");
      const results = unitResults(files);
      if (!results.length) return err(422, "NO_UNIT_TESTS", "This project has no unit tests the runner knows how to run.");
      const failed = results.filter((r) => r.status === "failed").length;
      return ok({
        engine: "fake",
        language: body.language ?? "python",
        entry: null,
        kind: body.kind ?? null,
        files_sent: files.map((f) => f.path),
        compile: null,
        tests: [],
        unit: { framework: "pytest", verdict: failed ? "failed" : "passed", total: results.length, passed: results.length - failed, failed, skipped: 0, errors: 0, time_ms: 30, output: "", truncated: false, tests: results },
        error: null,
      });
    }
    if (path === "/sessions" && method === "POST") {
      if (!caps.interactive) return err(409, "INTERACTIVE_UNAVAILABLE", "Live runs are off.");
      const entry = entryOf();
      const s: Session = { id: `s${++seq}`, entry: entry?.path ?? "main", crash: !!entry?.content.includes("BUG"), events: [], ended: false, listeners: new Set(), asked: false };
      sessions.set(s.id, s);
      // The program starts once someone listens (like the runner's box starting).
      return ok({ id: s.id }, 201);
    }
    let m = /^\/sessions\/([^/]+)\/input$/.exec(path);
    if (m && method === "POST") {
      const s = sessions.get(m[1]);
      if (!s) return err(404, "SESSION_NOT_FOUND", "No such run.");
      if (s.ended) return err(409, "SESSION_ENDED", "The program has ended.");
      if (body.signal) end(s, { code: null, signal: body.signal, verdict: "runtime-error" });
      else if (body.eof) {
        push(s, sse("stdout", { data: "Bye\n" }));
        end(s, { code: 0, verdict: "ok" });
      } else if (typeof body.data === "string") {
        const name = body.data.replace(/\n$/, "");
        push(s, sse("stdout", { data: `Hello, ${name}!\n` }));
        end(s, { code: 0, verdict: "ok" });
      }
      return { status: 204, body: null };
    }
    m = /^\/sessions\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") {
      const s = sessions.get(m[1]);
      if (s) end(s, { code: null, signal: "SIGTERM", verdict: "runtime-error" });
      return { status: 204, body: null };
    }
    return { status: 404, body: { error_code: "NOT_FOUND", message: `No route ${method} ${path}` } };
  }

  /** `GET /sessions/:id/events` as a stream: replays what happened, then follows. */
  function stream(path: string, onEvent: (e: TmStreamEvent) => void): { cancel(): void } {
    const m = /^\/sessions\/([^/]+)\/events$/.exec(path);
    const s = m ? sessions.get(m[1]) : undefined;
    let cancelled = false;
    const send = (e: TmStreamEvent) => !cancelled && setTimeout(() => !cancelled && onEvent(e), 0);
    if (!caps || !s) {
      send({ type: "status", status: 404 });
      send({ type: "data", data: JSON.stringify({ success: false, code: "SESSION_NOT_FOUND" }) });
      send({ type: "end" });
      return { cancel: () => (cancelled = true) };
    }
    send({ type: "status", status: 200 });
    // Uneven pieces: a parser must cope with events split anywhere.
    const listener = (chunk: string | null) => {
      if (chunk === null) return send({ type: "end" });
      const cut = Math.max(1, Math.floor(chunk.length / 3));
      send({ type: "data", data: chunk.slice(0, cut) });
      send({ type: "data", data: chunk.slice(cut) });
    };
    for (const c of s.events) listener(c);
    if (s.ended) listener(null);
    else s.listeners.add(listener);
    if (!s.asked) {
      s.asked = true;
      push(s, ": ping\n\n");
      push(s, sse("stage", { name: "run" }));
      if (s.crash) {
        push(s, sse("stderr", { data: `Traceback (most recent call last):\n  File "${s.entry}", line 1\nNameError: name 'BUG' is not defined\n` }));
        end(s, { code: 1, verdict: "runtime-error" });
      } else push(s, sse("stdout", { data: "What is your name? " }));
    }
    return {
      cancel() {
        cancelled = true;
        s.listeners.delete(listener);
      },
    };
  }

  const hooks = {
    setCapabilities(c: Partial<FakeCaps> | null) {
      caps = c ? { ...DEFAULT_CAPS, ...c } : null;
    },
    requests: () => sent.map((r) => ({ path: r.path, body: r.body })),
    failNext(status: number, code: string) {
      failNext = { status, code };
    },
  };
  if (typeof window !== "undefined") (window as unknown as { __TMCODE_CODE__: unknown }).__TMCODE_CODE__ = hooks;
  return { route, stream, hooks };
}
