// A mock Task Mentor implementing docs/PROTOCOL.md v1 for the exam e2e tests.
// It verifies snapshots exactly as the real server must (files_hash + HMAC
// chain with node:crypto), so it doubles as a contract test of the client.
// Test-only endpoints live under /__test.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_TM_PORT ?? 5099);
let state;

function reset() {
  state = {
    tickets: new Map(), // ticket -> { used }
    sessions: new Map(), // sid -> session
    deadlineMs: Date.now() + 30 * 60_000,
    message: null,
    paused: false,
    offline: false, // simulate the network being down (snapshots, heartbeat, submit)
    submitted: null,
    released: true,
    debugger: false, // policy.debugger: Run and Debug allowed in the exam
    policy: {}, // overrides of the exam policy (e.g. { terminal: "restricted" })
    serverRunLimit: 10, // server-run: runs per minute before 429 RATE_LIMITED (PROTOCOL.md §3)
    serverRuns: [], // timestamps of server runs
    minAppVersion: null, // package.min_app_version
    badPackage: false, // a package this client can't parse (a newer format)
    clockSkewMs: 0, // server_time = now + skew (a computer with a wrong clock)
    codeRunner: null, // /sessions/:sid/code capabilities ({ interactive, unit_tests, … }); null: an older Task Mentor (404)
    unitTask: false, // a third task checked by the teacher's unit tests (check_with "unit")
    codeRequests: [], // what reached /sessions/:sid/code (path + body)
    liveRuns: new Map(), // live run id -> { res, ended, buffer }
  };
}
reset();

const TASKS = [
  {
    question_id: 501,
    order: 1,
    points: 10,
    title: "Sum of two numbers",
    brief_md: "# Sum of two numbers\n\nRead two integers `a` and `b` on one line and print **a + b**.\n\n```\nInput:  2 3\nOutput: 5\n```",
    profile_id: "node-22",
    files: [{ path: "main.js", content: "// Read a and b, print their sum\nconst input = require('fs').readFileSync(0, 'utf8');\n" }],
    visible_tests: [
      { id: "v1", name: "small", input: "2 3\n", expected_output: "5\n", points: 2 },
      { id: "v2", name: "negative", input: "-1 4\n", expected_output: "3\n", points: 2 },
    ],
    hidden: [{ id: "h1", input: "100 250\n", expected_output: "350\n", points: 6 }],
  },
  {
    question_id: 502,
    order: 2,
    points: 5,
    title: "Greeting",
    brief_md: "Print `Hello, NGA!`.",
    profile_id: "node-22",
    files: [{ path: "main.js", content: "" }],
    visible_tests: [{ id: "v1", name: "greeting", input: "", expected_output: "Hello, NGA!\n", points: 5 }],
    hidden: [],
  },
];

const UNIT_TASK = {
  question_id: 503,
  order: 3,
  points: 10,
  title: "A stack",
  brief_md: "Write `push` and `pop` in `stack.js`. Write your own tests in `stack.test.js`.",
  profile_id: "node-22",
  check_with: "unit",
  files: [
    { path: "stack.js", content: "module.exports = { push(s, x) { s.push(x); }, pop(s) { return s.pop(); } };\n" },
    { path: "stack.test.js", content: 'const assert = require("node:assert");\nconst st = require("./stack");\ntest("push adds", () => {\n  const s = [];\n  st.push(s, 1);\n});\ntest("pop is empty", () => {\n  fail("not written yet");\n});\n' },
  ],
  visible_tests: [],
  hidden: [],
};
const tasksNow = () => (state.unitTask ? [...TASKS, UNIT_TASK] : TASKS);

/** Unit tests the way the code runner reports them (the same rules as the in-memory fake). */
function unitResults(files) {
  const tests = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    const starts = [];
    lines.forEach((l, i) => {
      const m = /^\s*(?:test|it)\(\s*["'`]([^"'`]+)["'`]/.exec(l) ?? /^\s*def (test_\w+)\s*\(/.exec(l);
      if (m) starts.push({ name: m[1], line: i + 1 });
    });
    starts.forEach((st, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].line - 1 : lines.length;
      const body = lines.slice(st.line, end);
      const bad = body.findIndex((l) => /assert False|FAIL|fail\(/.test(l));
      const line = bad >= 0 ? st.line + 1 + bad : st.line;
      tests.push({ id: `${f.path}::${st.name}`, name: st.name, group: f.path, file: f.path, line, status: bad >= 0 ? "failed" : "passed", durationMs: 2, message: bad >= 0 ? `AssertionError: ${body[bad].trim()}` : null, details: bad >= 0 ? `${f.path}:${line}` : null });
    });
  }
  return tests;
}

const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A live run: "What is your name? " → "Hello, <name>!"; End of Input → "Bye"; Ctrl+C / Stop end it. */
function liveWrite(run, chunk) {
  if (run.res) run.res.write(chunk);
  else run.buffer.push(chunk);
}
function liveEnd(run, exit) {
  if (run.ended) return;
  run.ended = true;
  liveWrite(run, sseFrame("exit", { signal: null, time_ms: 30, memory_kb: 800, ...exit }));
  run.res?.end();
}

async function codeRoute(req, res, s, rest) {
  const okJson = (status, data) => send(res, status, { success: true, data });
  const fail = (status, code, message) => send(res, status, { success: false, code, message: message ?? code });
  if (s.status !== "active") return err(res, 409, "SESSION_SUPERSEDED");
  if (!state.codeRunner) return err(res, 404, "NOT_FOUND");
  const b = req.method === "POST" ? await body(req) : {};
  if (rest !== "/capabilities") state.codeRequests.push({ path: rest, body: b });
  if (rest === "/capabilities" && req.method === "GET") return okJson(200, { interactive: false, pty: false, unit_tests: false, unit_test_languages: [], previews: false, ...state.codeRunner });
  if (rest === "/test" && req.method === "POST") {
    if (!tasksNow().some((t) => t.question_id === b.question_id)) return err(res, 400, "QUESTION_NOT_IN_EXAM");
    if (!state.codeRunner.unit_tests) return fail(409, "UNIT_TESTS_UNAVAILABLE");
    const tests = unitResults(b.files ?? []);
    if (!tests.length) return fail(422, "NO_UNIT_TESTS", "This project has no unit tests the runner knows how to run.");
    const failed = tests.filter((t) => t.status === "failed").length;
    return okJson(200, { engine: "mock", language: "javascript", entry: null, kind: null, files_sent: (b.files ?? []).map((f) => f.path), compile: null, tests: [], unit: { framework: "node-test", verdict: failed ? "failed" : "passed", total: tests.length, passed: tests.length - failed, failed, skipped: 0, errors: 0, time_ms: 20, output: "", truncated: false, tests }, error: null });
  }
  if (rest === "/sessions" && req.method === "POST") {
    if (!state.codeRunner.interactive) return fail(409, "INTERACTIVE_UNAVAILABLE");
    const id = randomUUID();
    const entry = (b.files ?? []).find((f) => f.path === b.entry) ?? b.files?.[0];
    state.liveRuns.set(id, { res: null, ended: false, buffer: [], crash: !!entry?.content?.includes("BUG"), entry: entry?.path });
    return okJson(201, { id });
  }
  let m = /^\/sessions\/([\w-]+)\/events$/.exec(rest);
  if (m && req.method === "GET") {
    const run = state.liveRuns.get(m[1]);
    if (!run) return fail(404, "SESSION_NOT_FOUND");
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
    run.res = res;
    for (const c of run.buffer.splice(0)) res.write(c);
    if (run.ended) return res.end();
    req.on("close", () => liveEnd(run, { code: null, signal: "SIGTERM", verdict: "runtime-error" }));
    res.write(": ping\n\n");
    liveWrite(run, sseFrame("stage", { name: "run" }));
    if (run.crash) {
      liveWrite(run, sseFrame("stderr", { data: `${run.entry}:1\nReferenceError: BUG is not defined\n` }));
      return liveEnd(run, { code: 1, verdict: "runtime-error" });
    }
    // Split one frame in two, as a proxy might.
    const ask = sseFrame("stdout", { data: "What is your name? " });
    res.write(ask.slice(0, 9));
    setTimeout(() => !run.ended && res.write(ask.slice(9)), 30);
    return;
  }
  m = /^\/sessions\/([\w-]+)\/input$/.exec(rest);
  if (m && req.method === "POST") {
    const run = state.liveRuns.get(m[1]);
    if (!run) return fail(404, "SESSION_NOT_FOUND");
    if (run.ended) return fail(409, "SESSION_ENDED");
    if (b.signal) liveEnd(run, { code: null, signal: b.signal, verdict: "runtime-error" });
    else if (b.eof) {
      liveWrite(run, sseFrame("stdout", { data: "Bye\n" }));
      liveEnd(run, { code: 0, verdict: "ok" });
    } else if (typeof b.data === "string") {
      liveWrite(run, sseFrame("stdout", { data: `Hello, ${b.data.replace(/\n$/, "")}!\n` }));
      liveEnd(run, { code: 0, verdict: "ok" });
    }
    return send(res, 204);
  }
  m = /^\/sessions\/([\w-]+)$/.exec(rest);
  if (m && req.method === "DELETE") {
    const run = state.liveRuns.get(m[1]);
    if (run) liveEnd(run, { code: null, signal: "SIGTERM", verdict: "runtime-error" });
    return send(res, 204);
  }
  return err(res, 404, "NOT_FOUND");
}

const PROFILE = {
  id: "node-22",
  version: 1,
  label: "JavaScript (Node.js)",
  monaco_language: "javascript",
  extensions: ["js", "mjs", "cjs"],
  entry_point: "main.js",
  template: [],
  local: { build: [], run: { tool: "node", args: ["{entry}"] }, fallback: "js-worker" },
  judge: { engine: "tmjudge", language: "node-22", version: "22" },
  preview: null,
  test_kinds: ["io"],
  limits: { cpu_s: 5, wall_s: 10, memory_mb: 256, output_kb: 256 },
};

const filesHash = (files) =>
  createHash("sha256")
    .update(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => [f.path, f.content])))
    .digest("hex");

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Date, Retry-After",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
const err = (res, status, error_code, message, extra = {}) => send(res, status, { error_code, message: message ?? error_code, ...extra });

/** Runs one JavaScript program like tm-judge would, with a verdict. */
async function judge(code, test) {
  const { execFileSync } = await import("node:child_process");
  const t0 = Date.now();
  try {
    // A clean environment: the test runner's NODE_OPTIONS/FORCE_COLOR would change the output.
    const env = { PATH: process.env.PATH, NO_COLOR: "1" };
    const out = execFileSync(process.execPath, ["-e", code], { input: test.input, timeout: 5000, env, stdio: ["pipe", "pipe", "pipe"] }).toString();
    const passed = out.trimEnd() === test.expected_output.trimEnd();
    return { stdout: out, stderr: "", passed, verdict: passed ? "accepted" : "wrong-answer", time_ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = e.code === "ETIMEDOUT" || e.signal === "SIGTERM";
    return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message).slice(0, 2000), passed: false, verdict: timedOut ? "time-limit" : "runtime-error", time_ms: Date.now() - t0 };
  }
}

async function body(req) {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function session(req, res, sid) {
  const s = state.sessions.get(sid);
  if (!s || req.headers.authorization !== `Bearer ${s.token}`) {
    err(res, 401, "UNAUTHORISED");
    return null;
  }
  return s;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204);
  try {
    // ── test controls ──
    if (p === "/__test/reset") return reset(), send(res, 200, { ok: true });
    if (p === "/__test/launch") {
      const ticket = randomBytes(24).toString("base64url");
      state.tickets.set(ticket, { used: false });
      const api = `http://localhost:${PORT}`;
      return send(res, 200, { ticket, deeplink: `tmcode://launch?t=${ticket}&api=${encodeURIComponent(api)}` });
    }
    if (p === "/__test/state") {
      return send(res, 200, {
        sessions: [...state.sessions.values()].map((s) => ({ sid: s.sid, status: s.status, snapshots: s.snapshots.map(({ files, ...r }) => ({ ...r, files })) })),
        submitted: state.submitted,
        codeRequests: state.codeRequests,
      });
    }
    if (p === "/__test/set" && req.method === "POST") {
      Object.assign(state, await body(req));
      return send(res, 200, { ok: true });
    }

    // ── protocol v1 ──
    // No auth (cached 5 min on Task Mentor); TMCode's system check uses it for "reachable" and the clock (Date header).
    if (p === "/api/tmcode/profiles" && req.method === "GET") {
      res.setHeader("Date", new Date(Date.now() + state.clockSkewMs).toUTCString());
      return send(res, 200, { profiles: [PROFILE] });
    }
    if (p === "/api/tmcode/sessions" && req.method === "POST") {
      const b = await body(req);
      const t = state.tickets.get(b.ticket);
      if (!t) return err(res, 401, "TICKET_INVALID");
      if (t.used) return err(res, 409, "TICKET_USED");
      t.used = true;
      for (const s of state.sessions.values()) if (s.status === "active") s.status = "superseded";
      const sid = randomUUID();
      const nonce = randomBytes(32).toString("base64");
      const s = { sid, token: randomBytes(24).toString("hex"), nonce, key: createHmac("sha256", Buffer.from(nonce, "base64")).update(`tmcode-journal-v1:${sid}`).digest(), snapshots: [], status: "active", device: b.device, env: b.env_report };
      state.sessions.set(sid, s);
      return send(res, 200, { session_id: sid, token: s.token, expires_at: new Date(state.deadlineMs + 3600_000).toISOString(), submission_id: 9001 });
    }
    const c = /^\/api\/tmcode\/sessions\/([\w-]+)\/code(\/.*)$/.exec(p);
    if (c) {
      const s = session(req, res, c[1]);
      if (!s) return;
      return await codeRoute(req, res, s, c[2]);
    }
    const m = /^\/api\/tmcode\/sessions\/([\w-]+)\/(\w[\w-]*)$/.exec(p);
    if (m) {
      const s = session(req, res, m[1]);
      if (!s) return;
      const action = m[2];
      // The network is down: only the session start (already done) got through.
      if (state.offline && ["snapshots", "heartbeat", "submit", "telemetry", "results", "server-run"].includes(action)) return req.destroy();
      if (action === "package" && req.method === "GET" && state.badPackage) {
        // A newer package format: tasks renamed, as an outdated TMCode would see it.
        return send(res, 200, { submission_id: 9001, quiz: { id: 77, title: "Practical 1", type: "Exam" }, format: 2, items: [] });
      }
      if (action === "package" && req.method === "GET") {
        // Latest synced snapshot of the question across all of this submission's sessions.
        const latest = (qid) =>
          [...state.sessions.values()]
            .flatMap((x) => x.snapshots)
            .filter((x) => x.question_id === qid)
            .sort((a, b) => a.server_ts.localeCompare(b.server_ts))
            .at(-1);
        return send(res, 200, {
          submission_id: 9001,
          quiz: { id: 77, title: "Practical 1 — JavaScript basics", type: "Exam" },
          deadline: new Date(state.deadlineMs).toISOString(),
          server_time: new Date(Date.now() + state.clockSkewMs).toISOString(),
          policy: { mode: "monitored", intelligence: "basic", paste: "internal_only", terminal: "off", internet_in_preview: false, require_seb: false, allow_offline_grace_minutes: 10, locked_settings: [], ...(state.debugger ? { debugger: true } : {}), ...state.policy },
          journal_nonce: s.nonce,
          profiles: [PROFILE],
          toolchains: ["node"],
          tasks: tasksNow().map(({ hidden, ...t }) => {
            const l = latest(t.question_id);
            return { ...t, hidden_test_count: hidden.length, resume: l ? { snapshot_seq: l.seq, files: l.files } : null };
          }),
          live: null,
          ...(state.minAppVersion ? { min_app_version: state.minAppVersion } : {}),
        });
      }
      if (action === "snapshots" && req.method === "POST") {
        const b = await body(req);
        if (s.status !== "active") return err(res, 409, "SESSION_SUPERSEDED");
        // As Task Mentor does: work stamped after the deadline is refused (a final snapshot carries the deadline).
        if (Date.parse(b.client_ts) > state.deadlineMs + 2000) return err(res, 409, "ATTEMPT_TIME_EXPIRED", "Time is up.");
        const existing = s.snapshots.find((x) => x.seq === b.seq);
        if (existing) return existing.hmac === b.hmac ? send(res, 200, { accepted_seq: b.seq, server_ts: existing.server_ts }) : err(res, 409, "SEQ_CONFLICT");
        const expected = (s.snapshots.at(-1)?.seq ?? 0) + 1;
        if (b.seq !== expected) return send(res, 409, { error_code: "SEQ_GAP", message: "gap", expected_seq: expected });
        if (filesHash(b.files) !== b.files_hash) return err(res, 409, "JOURNAL_TAMPERED", "files_hash mismatch");
        const prev = s.snapshots.at(-1)?.hmac ?? "";
        const mac = createHmac("sha256", s.key).update(`${prev}|${b.seq}|${b.question_id}|${b.kind}|${b.files_hash}|${b.client_ts}`).digest("hex");
        if (mac !== b.hmac) return err(res, 409, "JOURNAL_TAMPERED", "chain broken");
        const rec = { ...b, server_ts: new Date().toISOString() };
        s.snapshots.push(rec);
        return send(res, 200, { accepted_seq: b.seq, server_ts: rec.server_ts });
      }
      if (action === "telemetry") return send(res, 200, { ok: true });
      if (action === "server-run" && req.method === "POST") {
        const b = await body(req);
        if (s.status !== "active") return err(res, 409, "SESSION_SUPERSEDED");
        const task = TASKS.find((t) => t.question_id === b.question_id);
        if (!task) return err(res, 400, "QUESTION_NOT_IN_EXAM");
        if (!Array.isArray(b.files) || b.files.length > 300) return err(res, 400, "VALIDATION_ERROR");
        const now = Date.now();
        state.serverRuns = state.serverRuns.filter((t) => now - t < 60_000);
        if (state.serverRuns.length >= state.serverRunLimit) {
          const retry = Math.max(1, Math.ceil((state.serverRuns[0] + 60_000 - now) / 1000));
          res.setHeader("Retry-After", String(retry));
          return err(res, 429, "RATE_LIMITED", "Too many server runs — wait a minute and try again.", { retry_after_s: retry });
        }
        state.serverRuns.push(now);
        const code = b.files.find((f) => f.path === "main.js")?.content ?? "";
        const tests = [];
        for (const t of task.visible_tests) tests.push({ id: t.id, ...(await judge(code, t)) });
        return send(res, 200, { tests });
      }
      if (action === "heartbeat") {
        return send(res, 200, { server_time: new Date().toISOString(), deadline: new Date(state.deadlineMs).toISOString(), status: s.status, paused: state.paused, message: state.message });
      }
      if (action === "submit" && req.method === "POST") {
        const b = await body(req);
        for (const f of b.final) if (!s.snapshots.some((x) => x.seq === f.seq && x.question_id === f.question_id)) return err(res, 409, "SNAPSHOT_MISSING");
        state.submitted = { at: new Date().toISOString(), final: b.final };
        s.status = "ended";
        return send(res, 200, { status: "grading" });
      }
      if (action === "results") {
        if (!state.submitted) return err(res, 409, "NOT_SUBMITTED");
        if (!state.released) return send(res, 200, { status: "hidden" });
        // "Grade" with node: run every test (visible + hidden) on the final snapshot.
        const questions = [];
        for (const { question_id, seq } of state.submitted.final) {
          const snap = s.snapshots.find((x) => x.seq === seq);
          const task = tasksNow().find((t) => t.question_id === question_id);
          const code = snap.files.find((f) => f.path === "main.js")?.content ?? "";
          const tests = [];
          for (const t of [...task.visible_tests.map((t) => ({ ...t, hidden: false })), ...task.hidden.map((t) => ({ ...t, hidden: true }))]) {
            const r = await judge(code, t);
            tests.push({ id: t.id, name: t.name, hidden: t.hidden, passed: r.passed, verdict: r.verdict, points: t.points });
          }
          questions.push({ question_id, points: tests.filter((t) => t.passed).reduce((n, t) => n + t.points, 0), max_points: task.points, tests: tests.map(({ points, ...t }) => t) });
        }
        return send(res, 200, { status: "released", score: questions.reduce((n, q) => n + q.points, 0), max_score: tasksNow().reduce((n, t) => n + t.points, 0), questions });
      }
    }
    err(res, 404, "NOT_FOUND");
  } catch (e) {
    err(res, 500, "MOCK_ERROR", String(e?.message ?? e));
  }
}).listen(PORT, () => console.log(`mock Task Mentor on http://localhost:${PORT}`));
