import { describe, expect, it, vi } from "vitest";
import { capabilities, codeErrorWords, CodeRunnerError, normalizeCapabilities, runsUnitTests, sseParser, startSession, unwrap, verdictTone, verdictWords, type CodeTransport, type SessionEvent } from "./codeRunner";
import { createFakeCodeRunner, unitResults } from "../platform/memoryCodeRunner";
import { remoteHandle } from "./serverRun";

/** A transport over the in-memory fake (the same one the dev server and e2e use). */
function fakeTransport(where: "account" | "exam" = "account") {
  const fake = createFakeCodeRunner();
  fake.hooks.setCapabilities({});
  const t: CodeTransport = {
    where,
    async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
      const r = fake.route(method, path, (body ?? {}) as Record<string, unknown>);
      if (r.status >= 300) {
        const b = r.body as Record<string, string>;
        throw new CodeRunnerError(r.status, b.code ?? b.error_code, b.message);
      }
      return r.body as T;
    },
    stream: (path, on) =>
      fake.stream(path, (e) => {
        if (e.type === "status") on.status?.(e.status);
        else if (e.type === "data") on.data(e.data);
        else on.end(e.type === "error" ? e.message : undefined);
      }),
  };
  return { t, fake };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("sseParser", () => {
  it("reads events split anywhere, skips pings, and copes with CRLF", () => {
    const got: SessionEvent[] = [];
    const push = sseParser((e) => got.push(e));
    const text = ': ping\r\n\r\nevent: stage\r\ndata: {"name":"run"}\r\n\r\nevent: stdout\ndata: {"data":"Hi\\n"}\n\nevent: exit\ndata: {"code":0,"signal":null,"verdict":"ok","time_ms":5,"memory_kb":10}\n\n';
    for (let i = 0; i < text.length; i += 7) push(text.slice(i, i + 7));
    expect(got).toEqual([
      { type: "stage", name: "run" },
      { type: "stdout", data: "Hi\n" },
      { type: "exit", code: 0, signal: null, verdict: "ok", time_ms: 5, memory_kb: 10 },
    ]);
  });

  it("ignores unknown events and bad JSON", () => {
    const got: SessionEvent[] = [];
    const push = sseParser((e) => got.push(e));
    push("event: preview\ndata: {}\n\nevent: stdout\ndata: not json\n\nevent: error\ndata: {\"message\":\"Output cap\"}\n\n");
    expect(got).toEqual([{ type: "error", message: "Output cap" }]);
  });
});

describe("capabilities", () => {
  it("normalizes the answer and unwraps { success, data }", () => {
    expect(normalizeCapabilities({ success: true, data: { interactive: true, unit_tests: true, unit_test_languages: ["python", 3] } })).toEqual({ interactive: true, pty: false, unit_tests: true, unit_test_languages: ["python"], previews: false });
    expect(normalizeCapabilities(null)).toBeNull();
    expect(unwrap({ data: 1 })).toBe(1);
    expect(unwrap({ success: true, data: 2 })).toBe(2);
    expect(unwrap({ data: 1, other: 2 })).toEqual({ data: 1, other: 2 });
  });

  it("is null when Task Mentor has no code runner (404), and asks again next time", async () => {
    const { t, fake } = fakeTransport();
    fake.hooks.setCapabilities(null);
    expect(await capabilities(t, true)).toBeNull();
    fake.hooks.setCapabilities({ interactive: false });
    expect((await capabilities(t))?.interactive).toBe(false);
    expect(await capabilities(null)).toBeNull();
  });

  it("knows which languages' unit tests run", () => {
    const c = normalizeCapabilities({ unit_tests: true, unit_test_languages: ["python"] });
    expect(runsUnitTests(c, "python")).toBe(true);
    expect(runsUnitTests(c, "java")).toBe(false);
    expect(runsUnitTests(c, null)).toBe(true);
    expect(runsUnitTests(normalizeCapabilities({ unit_tests: false }), "python")).toBe(false);
    expect(runsUnitTests(null, "python")).toBe(false);
  });
});

describe("live runs", () => {
  it("streams output, sends a line, and ends with exit", async () => {
    const { t, fake } = fakeTransport();
    const events: SessionEvent[] = [];
    const s = await startSession(t, { language: "python", entry: "main.py", files: [{ path: "main.py", content: "name = input()" }] }, (e) => events.push(e));
    await flush();
    expect(events.slice(0, 2)).toEqual([{ type: "stage", name: "run" }, { type: "stdout", data: "What is your name? " }]);
    await s.input("Ada\n");
    await flush();
    expect(events.at(-2)).toEqual({ type: "stdout", data: "Hello, Ada!\n" });
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0, verdict: "ok" });
    expect(fake.hooks.requests().map((r) => r.path)).toEqual(["/sessions", `/sessions/${s.id}/input`]);
    expect(fake.hooks.requests()[0].body).toMatchObject({ pty: false, entry: "main.py" });
  });

  it("Ctrl+C, End of Input and Stop", async () => {
    const { t } = fakeTransport();
    const files = [{ path: "main.py", content: "" }];
    let events: SessionEvent[] = [];
    let s = await startSession(t, { files }, (e) => events.push(e));
    await flush();
    await s.interrupt();
    await flush();
    expect(events.at(-1)).toMatchObject({ type: "exit", signal: "SIGINT" });
    // Input after the end goes nowhere (no error).
    await s.input("late\n");

    events = [];
    s = await startSession(t, { files }, (e) => events.push(e));
    await flush();
    await s.eof();
    await flush();
    expect(events.slice(-2)).toEqual([{ type: "stdout", data: "Bye\n" }, expect.objectContaining({ type: "exit", code: 0 })]);

    events = [];
    s = await startSession(t, { files }, (e) => events.push(e));
    await flush();
    await s.stop();
    await flush();
    expect(events.at(-1)).toMatchObject({ type: "exit", signal: "SIGTERM" });
    expect(events.filter((e) => e.type === "exit")).toHaveLength(1);
  });

  it("a crash streams stderr then exit 1", async () => {
    const { t } = fakeTransport();
    const events: SessionEvent[] = [];
    await startSession(t, { files: [{ path: "main.py", content: "BUG" }] }, (e) => events.push(e));
    await flush();
    expect(events.find((e) => e.type === "stderr")).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 1, verdict: "runtime-error" });
  });

  it("a broken stream still ends the run once", async () => {
    const events: SessionEvent[] = [];
    const t: CodeTransport = {
      where: "account",
      call: async <T,>() => ({ success: true, data: { id: "x" } }) as T,
      stream: (_p, on) => {
        setTimeout(() => {
          on.status?.(200);
          on.data("event: stdout\ndata: {\"data\":\"a\"}\n\n");
          on.end("socket hang up");
        }, 0);
        return { cancel() {} };
      },
    };
    await startSession(t, { files: [{ path: "a", content: "" }] }, (e) => events.push(e));
    await flush();
    expect(events.map((e) => e.type)).toEqual(["stdout", "error", "exit"]);
  });

  it("can't start without streaming: says so and stops the run", async () => {
    const del = vi.fn();
    const t: CodeTransport = {
      where: "account",
      call: async <T,>(method: string) => {
        if (method === "DELETE") del();
        return { success: true, data: { id: "x" } } as T;
      },
      stream: () => null,
    };
    await expect(startSession(t, { files: [{ path: "a", content: "" }] }, () => {})).rejects.toMatchObject({ code: "NO_STREAM" });
    await flush();
    expect(del).toHaveBeenCalled();
  });
});

describe("the Run console's typing for a run on Task Mentor", () => {
  it("echoes, edits and sends lines; Ctrl+C and Ctrl+D", async () => {
    const calls: string[] = [];
    const session = {
      id: "s",
      input: async (d: string) => void calls.push(`in:${d}`),
      eof: async () => void calls.push("eof"),
      interrupt: async () => void calls.push("int"),
      stop: async () => void calls.push("stop"),
    };
    let echo = "";
    const h = remoteHandle(session, (t) => (echo += t));
    h.input("Adx\x7fa\r");
    h.input("rest");
    h.input("\x04");
    h.input("\x03");
    h.kill();
    expect(calls).toEqual(["in:Ada\n", "in:rest", "eof", "int", "stop"]);
    expect(echo).toBe("Adx\b \ba\r\nrest^C\r\n");
    expect(h.stopped()).toBe(true);
  });
});

describe("plain words and colours", () => {
  it("maps verdicts to words and status colours", () => {
    expect(verdictTone("accepted")).toBe("passed");
    expect(verdictTone("wrong-answer")).toBe("failed");
    expect(verdictTone("compile-error")).toBe("failed");
    expect(verdictTone("runtime-error")).toBe("failed");
    expect(verdictTone("time-limit")).toBe("limit");
    expect(verdictTone("memory-limit")).toBe("limit");
    expect(verdictTone("package-not-available")).toBe("limit");
    expect(verdictTone("queued")).toBe("info");
    expect(verdictWords("package-not-available")).toBe("Uses a package the code runner doesn't have");
    expect(verdictWords(undefined)).toBeNull();
  });

  it("explains errors without codes or jargon", () => {
    expect(codeErrorWords(new CodeRunnerError(429, "RATE_LIMITED", "x"))).toMatch(/Wait a minute/);
    expect(codeErrorWords(new CodeRunnerError(0, "OFFLINE", "fetch failed"))).toMatch(/can't be reached/);
    expect(codeErrorWords(new CodeRunnerError(503, "RUNNER_BUSY", "x"))).toMatch(/busy/);
    for (const code of ["RATE_LIMITED", "JUDGE_UNAVAILABLE", "NO_UNIT_TESTS", "SESSION_ENDED"]) {
      expect(codeErrorWords(new CodeRunnerError(400, code, ""))).not.toMatch(/judge|tm-judge|Judge0/i);
    }
  });
});

describe("the fake's unit tests (shared rules with the exam mock)", () => {
  it("finds Python, JavaScript and Java tests and points failures at their line", () => {
    const r = unitResults([
      { path: "tests/test_calc.py", content: "def test_add():\n    assert 1 + 1 == 2\n\ndef test_div():\n    assert False, 'div'\n" },
      { path: "calc.test.js", content: 'test("adds", () => {});\nit("fails", () => {\n  fail("no");\n});\n' },
      { path: "CalcTest.java", content: "class CalcTest {\n  @Test\n  void adds() {}\n}\n" },
    ]);
    expect(r.map((x) => [x.name, x.status, x.line])).toEqual([
      ["test_add", "passed", 1],
      ["test_div", "failed", 5],
      ["adds", "passed", 1],
      ["fails", "failed", 3],
      ["adds", "passed", 3],
    ]);
  });
});
