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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
const err = (res, status, error_code, message) => send(res, status, { error_code, message: message ?? error_code });

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
      });
    }
    if (p === "/__test/set" && req.method === "POST") {
      Object.assign(state, await body(req));
      return send(res, 200, { ok: true });
    }

    // ── protocol v1 ──
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
    const m = /^\/api\/tmcode\/sessions\/([\w-]+)\/(\w[\w-]*)$/.exec(p);
    if (m) {
      const s = session(req, res, m[1]);
      if (!s) return;
      const action = m[2];
      // The network is down: only the session start (already done) got through.
      if (state.offline && ["snapshots", "heartbeat", "submit", "telemetry", "results"].includes(action)) return req.destroy();
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
          server_time: new Date().toISOString(),
          policy: { mode: "monitored", intelligence: "basic", paste: "internal_only", terminal: "off", internet_in_preview: false, require_seb: false, allow_offline_grace_minutes: 10, locked_settings: [], ...(state.debugger ? { debugger: true } : {}), ...state.policy },
          journal_nonce: s.nonce,
          profiles: [PROFILE],
          toolchains: ["node"],
          tasks: TASKS.map(({ hidden, ...t }) => {
            const l = latest(t.question_id);
            return { ...t, hidden_test_count: hidden.length, resume: l ? { snapshot_seq: l.seq, files: l.files } : null };
          }),
          live: null,
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
        const { execFileSync } = await import("node:child_process");
        const questions = state.submitted.final.map(({ question_id, seq }) => {
          const snap = s.snapshots.find((x) => x.seq === seq);
          const task = TASKS.find((t) => t.question_id === question_id);
          const code = snap.files.find((f) => f.path === "main.js")?.content ?? "";
          const tests = [...task.visible_tests.map((t) => ({ ...t, hidden: false })), ...task.hidden.map((t) => ({ ...t, hidden: true }))].map((t) => {
            let out = "";
            try {
              // A clean environment: the test runner's NODE_OPTIONS/FORCE_COLOR would change the output.
              const env = { PATH: process.env.PATH, NO_COLOR: "1" };
              out = execFileSync(process.execPath, ["-e", code], { input: t.input, timeout: 5000, env }).toString();
            } catch (e) {
              console.error(`[mock-tm] grading ${t.id} failed: ${String(e.stderr ?? e.message).slice(0, 300)}`);
            }
            return { id: t.id, name: t.name, hidden: t.hidden, passed: out.trimEnd() === t.expected_output.trimEnd(), points: t.points };
          });
          return { question_id, points: tests.filter((t) => t.passed).reduce((n, t) => n + t.points, 0), max_points: task.points, tests: tests.map(({ points, ...t }) => t) };
        });
        return send(res, 200, { status: "released", score: questions.reduce((n, q) => n + q.points, 0), max_score: TASKS.reduce((n, t) => n + t.points, 0), questions });
      }
    }
    err(res, 404, "NOT_FOUND");
  } catch (e) {
    err(res, 500, "MOCK_ERROR", String(e?.message ?? e));
  }
}).listen(PORT, () => console.log(`mock Task Mentor on http://localhost:${PORT}`));
