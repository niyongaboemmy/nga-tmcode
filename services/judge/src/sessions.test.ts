import type { AddressInfo } from "node:net";
import type { Server, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrograms } from "./judge.ts";
import { IsolateSandbox, LocalSandbox, type Sandbox } from "./sandbox.ts";
import { SessionManager, unbufferedForSession, withNodeStdinPreload, type SessionEvent, type SessionOptions } from "./sessions.ts";
import { availability, resolveToolchains } from "./toolchains.ts";
import { kindById } from "../../../packages/runtimes/src/index.ts";

/** Interactive sessions: pipes in, server-sent events out (docs/PROTOCOL.md "Sessions"). */
const useIsolate = process.env.JUDGE_TEST_SANDBOX === "isolate";
const sandbox: Sandbox = useIsolate ? new IsolateSandbox(process.env.ISOLATE_BIN ?? "isolate", 4, 30) : new LocalSandbox();
const programs = resolvePrograms();
const tc = resolveToolchains();
const hasPython = programs.has("python3");

/** A stand-in for the HTTP response: parses what subscribe() writes. */
function listen(m: SessionManager, id: string) {
  const events: SessionEvent[] = [];
  const raw: string[] = [];
  const closers: (() => void)[] = [];
  let ended!: () => void;
  const finished = new Promise<void>((r) => (ended = r));
  const waiters: { pred: (e: SessionEvent[]) => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const w of [...waiters]) if (w.pred(events)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  const res = {
    headers: {} as Record<string, string>,
    writeHead(_status: number, headers: Record<string, string>) {
      this.headers = headers;
    },
    write(chunk: string) {
      raw.push(chunk);
      const m2 = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      if (m2) events.push({ event: m2[1], data: JSON.parse(m2[2]) } as SessionEvent);
      check();
      return true;
    },
    end() {
      ended();
      for (const c of closers.splice(0)) c();
    },
    on(ev: string, cb: () => void) {
      if (ev === "close") closers.push(cb);
    },
  };
  m.subscribe(id, res as unknown as ServerResponse);
  return {
    events,
    raw,
    res,
    finished,
    /** Simulates the client disconnecting. */
    disconnect: () => {
      for (const c of closers.splice(0)) c();
    },
    until: (pred: (e: SessionEvent[]) => boolean, ms = 20_000) =>
      new Promise<void>((resolve, reject) => {
        if (pred(events)) return resolve();
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`timed out; events so far: ${JSON.stringify(events)}`)), ms);
      }),
  };
}

const out = (es: SessionEvent[], ev: "stdout" | "stderr" = "stdout") => es.filter((e) => e.event === ev).map((e) => (e.data as { data: string }).data).join("");
const exitOf = (es: SessionEvent[]) => es.find((e) => e.event === "exit")?.data as { code: number | null; signal: string | null; verdict: string; time_ms: number } | undefined;
const manager = (o: SessionOptions = {}) => new SessionManager(sandbox, programs, tc, { keepMs: 5_000, ...o });

describe.runIf(hasPython)("sessions (python-3 profile)", () => {
  it("streams a prompt, takes stdin and exits", async () => {
    const m = manager();
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "name = input('Name? ')\nprint(f'Hello {name}')\n" }] });
    const l = listen(m, id);
    await l.until((es) => out(es).includes("Name?"));
    m.stdin(id, { data: "Ada\n" });
    await l.finished;
    expect(l.events[0]).toEqual({ event: "stage", data: { name: "run" } });
    expect(out(l.events)).toBe("Name? Hello Ada\n");
    expect(exitOf(l.events)).toMatchObject({ code: 0, signal: null, verdict: "ok" });
    expect(l.raw.find((r) => r.startsWith("event: exit"))).toMatch(/^event: exit\ndata: \{.*\}\n\n$/);
    expect(m.running).toBe(0);
  });

  it("accepts stdin sent before the program starts, and eof", async () => {
    const m = manager();
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "import sys\nprint(len(sys.stdin.read().split()))\n" }] });
    m.stdin(id, { data: "a b c\n" });
    m.eof(id);
    const l = listen(m, id);
    await l.finished;
    expect(out(l.events)).toBe("3\n");
    expect(exitOf(l.events)?.verdict).toBe("ok");
  });

  it("reports runtime errors on stderr", async () => {
    const m = manager();
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "raise SystemExit(3)\n" }] });
    const l = listen(m, id);
    await l.finished;
    expect(exitOf(l.events)).toMatchObject({ code: 3, verdict: "runtime-error" });
  });

  it("forwards SIGINT", async () => {
    const m = manager();
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "import time\nprint('ready', flush=True)\nwhile True: time.sleep(0.1)\n" }] });
    const l = listen(m, id);
    await l.until((es) => out(es).includes("ready"));
    m.signal(id, { name: "SIGINT" });
    await l.finished;
    const exit = exitOf(l.events)!;
    expect(exit.verdict).toBe("runtime-error");
    if (!useIsolate) expect([exit.signal, exit.code]).not.toEqual([null, 0]);
    expect(() => m.signal(id, { name: "SIGKILL" })).toThrow(/SIGINT/);
  });

  it("stops at the output cap with an error event", async () => {
    const m = manager({ outputBytes: 10_000 });
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "while True: print('x' * 100)\n" }] });
    const l = listen(m, id);
    await l.finished;
    expect(out(l.events).length).toBeLessThanOrEqual(10_000);
    expect(l.events.some((e) => e.event === "error" && /stopped/.test((e.data as { message: string }).message))).toBe(true);
    expect(exitOf(l.events)?.verdict).toBe("output-limit");
  });

  it("closes idle sessions", async () => {
    const m = manager({ idleMs: 800 });
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "input()\n" }] });
    const l = listen(m, id);
    await l.finished;
    expect(l.events.some((e) => e.event === "error" && /No input or output/.test((e.data as { message: string }).message))).toBe(true);
    expect(exitOf(l.events)?.verdict).toBe("time-limit");
  });

  it("enforces the wall clock", async () => {
    const m = manager({ wallMs: 1000 });
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "import time\nwhile True:\n    print('.', flush=True)\n    time.sleep(0.2)\n" }] });
    const l = listen(m, id);
    await l.finished;
    expect(exitOf(l.events)?.verdict).toBe("time-limit");
  });

  it("refuses sessions over the limit with 429, and frees the slot on DELETE", async () => {
    const m = manager({ max: 1 });
    const files = [{ path: "main.py", content: "input()\n" }];
    const { id } = m.create({ language: "python-3", entry: "main.py", files });
    expect(() => m.create({ language: "python-3", entry: "main.py", files })).toThrow(expect.objectContaining({ status: 429, code: "BUSY" }));
    await m.remove(id);
    expect(m.running).toBe(0);
    expect(() => m.get(id)).toThrow(expect.objectContaining({ status: 404 }));
    const again = m.create({ language: "python-3", entry: "main.py", files });
    await m.remove(again.id);
  });

  it("cleans up when the event stream disconnects", async () => {
    const m = manager();
    const { id } = m.create({ language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "print('hi', flush=True)\ninput()\n" }] });
    const l = listen(m, id);
    await l.until((es) => out(es).includes("hi"));
    l.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    expect(m.running).toBe(0);
    expect(() => m.stdin(id, { data: "x" })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("validates requests", () => {
    const m = manager();
    expect(() => m.create({ language: "python-3", entry: "nope.py", files: [{ path: "main.py", content: "" }] })).toThrow(/Entry/);
    expect(() => m.create({ kind: "cobol/x", files: [{ path: "a", content: "" }] })).toThrow(/Unknown project kind/);
    expect(() => m.create([])).toThrow(/JSON object/);
    expect(m.running).toBe(0);
  });
});

describe.runIf(programs.has("gcc"))("sessions (compiled)", () => {
  it("shows the build stage and compile errors", async () => {
    const m = manager();
    const { id } = m.create({ language: "c17", entry: "main.c", files: [{ path: "main.c", content: "int main(void) { return x; }\n" }] });
    const l = listen(m, id);
    await l.finished;
    expect(l.events[0]).toEqual({ event: "stage", data: { name: "build" } });
    expect(out(l.events, "stderr")).toMatch(/x/);
    expect(exitOf(l.events)?.verdict).toBe("compile-error");
  });

  it.runIf(availability(tc, kindById("c/single")!).available)("runs a catalog kind interactively", async () => {
    const m = manager();
    const { id } = m.create({
      kind: "c/single",
      files: [{ path: "main.c", content: '#include <stdio.h>\nint main(void) { int n; printf("n? "); fflush(stdout); if (scanf("%d", &n) != 1) return 1; printf("%d\\n", n * 2); return 0; }\n' }],
    });
    const l = listen(m, id);
    await l.until((es) => out(es).includes("n?"));
    m.stdin(id, { data: "21\n" });
    await l.finished;
    expect(l.events.map((e) => e.event).slice(0, 2)).toEqual(["stage", "stage"]);
    expect(out(l.events)).toBe("n? 42\n");
    expect(exitOf(l.events)).toMatchObject({ code: 0, verdict: "ok" });
  });

  it.runIf(availability(tc, kindById("sql/sqlite")!).available)("feeds SQL its script on stdin and ends (no typed input needed)", async () => {
    const m = manager();
    const { id } = m.create({
      kind: "sql/sqlite",
      files: [{ path: "main.sql", content: "CREATE TABLE parts (name TEXT, price INTEGER);\nINSERT INTO parts VALUES ('Oil filter', 5000), ('Brake pad', 12000);\nSELECT name FROM parts ORDER BY price DESC;\n" }],
    });
    const l = listen(m, id);
    await l.finished;
    expect(out(l.events)).toMatch(/Brake pad[\s\S]*Oil filter/);
    expect(exitOf(l.events)).toMatchObject({ code: 0, verdict: "ok" });
  });
});

describe.runIf(hasPython && !useIsolate)("sessions over HTTP", () => {
  const TOKEN = "t".repeat(32);
  let server: Server;
  let base = "";
  beforeAll(async () => {
    Object.assign(process.env, { JUDGE_TOKEN: TOKEN, JUDGE_SANDBOX: "none", JUDGE_PORT: "0", JUDGE_SESSIONS: "2" });
    const { start } = await import("./server.ts");
    server = await start();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });
  const call = (method: string, path: string, body?: unknown, token = TOKEN) =>
    fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("advertises sessions in /v1/health", async () => {
    const h = (await (await call("GET", "/v1/health")).json()) as { features: string[]; sessions: { max: number } };
    expect(Array.isArray(h.features)).toBe(true);
    expect(h.features).toContain("sessions");
    expect(h.sessions.max).toBe(2);
  });

  it("runs the whole protocol", async () => {
    expect((await call("POST", "/v1/sessions", {}, "wrong-token-wrong-token-wrong")).status).toBe(401);
    const created = await call("POST", "/v1/sessions", { language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "print(input()[::-1])\n" }] });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const stream = await call("GET", `/v1/sessions/${id}/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect((await call("POST", `/v1/sessions/${id}/stdin`, { data: "abc\n" })).status).toBe(204);
    expect((await call("POST", `/v1/sessions/${id}/eof`)).status).toBe(204);
    const text = await stream.text();
    expect(text).toContain('event: stage\ndata: {"name":"run"}\n\n');
    expect(text).toContain('event: stdout\ndata: {"data":"cba\\n"}\n\n');
    expect(text).toMatch(/event: exit\ndata: \{"code":0,"signal":null,"verdict":"ok","time_ms":\d+,"memory_kb":null\}\n\n$/);
    expect((await call("POST", `/v1/sessions/${id}/stdin`, { data: "x" })).status).toBe(409);
    expect((await call("DELETE", `/v1/sessions/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/v1/sessions/${id}`)).status).toBe(404);
  });

  it("answers 429 over the session limit and signals over HTTP", async () => {
    const body = { language: "python-3", entry: "main.py", files: [{ path: "main.py", content: "import time\nwhile True: time.sleep(0.1)\n" }] };
    const a = (await (await call("POST", "/v1/sessions", body)).json()) as { id: string };
    const b = (await (await call("POST", "/v1/sessions", body)).json()) as { id: string };
    const c = await call("POST", "/v1/sessions", body);
    expect(c.status).toBe(429);
    expect(((await c.json()) as { code: string }).code).toBe("BUSY");
    expect((await call("POST", `/v1/sessions/${a.id}/signal`, { name: "SIGTERM" })).status).toBe(204);
    expect((await call("DELETE", `/v1/sessions/${a.id}`)).status).toBe(204);
    expect((await call("DELETE", `/v1/sessions/${b.id}`)).status).toBe(204);
  });
});

describe("prompts appear before the answer (no fflush needed)", () => {
  it("unbuffers stdbuf's options only", () => {
    expect(unbufferedForSession(["/usr/bin/stdbuf", "-oL", "-eL", "/box/main", "-oL"])).toEqual(["/usr/bin/stdbuf", "-o0", "-e0", "/box/main", "-oL"]);
    expect(unbufferedForSession(["/usr/bin/python3", "-u", "main.py"])).toEqual(["/usr/bin/python3", "-u", "main.py"]);
    expect(unbufferedForSession([])).toEqual([]);
  });

  const C_PROMPT = '#include <stdio.h>\nint main(void) { char n[64]; printf("Name: "); if (scanf("%63s", n) != 1) return 1; printf("Hi %s\\n", n); return 0; }\n';
  for (const req of [
    { label: "c/single (catalog)", runIf: availability(tc, kindById("c/single")!).available, body: { kind: "c/single", files: [{ path: "main.c", content: C_PROMPT }] } },
    { label: "c17 (profile)", runIf: programs.has("gcc"), body: { language: "c17", entry: "main.c", files: [{ path: "main.c", content: C_PROMPT }] } },
  ]) {
    it.runIf(req.runIf)(`${req.label}: printf without a newline shows before scanf waits`, async () => {
      const m = manager();
      const { id } = m.create(req.body);
      const l = listen(m, id);
      await l.until((es) => out(es).includes("Name: "), 30_000);
      expect(out(l.events)).toBe("Name: ");
      m.stdin(id, { data: "Ada\n" });
      await l.finished;
      expect(out(l.events)).toBe("Name: Hi Ada\n");
    }, 60_000);
  }
});

describe("Node ends like in a terminal once it stops reading", () => {
  it("preloads the stdin helper for node only", () => {
    expect(withNodeStdinPreload(["/opt/node-22/bin/node", "main.js"])).toEqual(["/opt/node-22/bin/node", "-r", "./.nga/session-stdin.cjs", "main.js"]);
    expect(withNodeStdinPreload(["/usr/bin/python3", "-u", "main.py"])).toEqual(["/usr/bin/python3", "-u", "main.py"]);
  });
  const RL = 'const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });\nrl.question("Name? ", (a) => { console.log("Hi " + a); rl.close(); });\n';
  for (const req of [
    { label: "node-22 (profile)", runIf: programs.has("node"), body: { language: "node-22", entry: "main.js", files: [{ path: "main.js", content: RL }] } },
    { label: "js/single (catalog)", runIf: availability(tc, kindById("js/single")!).available, body: { kind: "js/single", entry: "main.js", files: [{ path: "main.js", content: RL }] } },
  ]) {
    it.runIf(req.runIf)(`${req.label}: rl.close() ends the program though stdin stays open`, async () => {
      const m = manager();
      const { id } = m.create(req.body);
      const l = listen(m, id);
      await l.until((es) => out(es).includes("Name? "), 30_000);
      m.stdin(id, { data: "Ada\n" });
      await l.finished;
      expect(out(l.events)).toBe("Name? Hi Ada\n");
      expect(exitOf(l.events)).toMatchObject({ code: 0, verdict: "ok" });
    }, 60_000);
  }
});
