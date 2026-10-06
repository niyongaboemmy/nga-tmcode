import { create } from "zustand";
import { getDocument, saveAll } from "../monaco/documents";
import { getPlatform, log, showPanel } from "../state/store";
import { dirname, extname } from "../util/paths";
import { decodeMappings, inspectValue, originalPosition, type JsValue, type SourceMapLike } from "./jsInspect";

/**
 * The JavaScript Console (Panel): runs a JS/TS file in a sandboxed Web Worker
 * and shows its console output as structured values — expandable objects,
 * errors with clickable stacks — like the browser devtools console. The same
 * worker then answers typed expressions (a REPL), so it works in the browser
 * build and in exams without a terminal.
 */

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug" | "group" | "input" | "result" | "system";

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  args: JsValue[];
  /** Indentation from console.group(). */
  group: number;
  /** Repeated identical lines collapse into one with a count. */
  count: number;
  /** "system" lines: running / finished / stopped notes. */
  text?: string;
  /** For "system": the run's outcome. */
  outcome?: "ok" | "error" | "stopped";
  /** console.trace() */
  trace?: string;
}

export interface JsConsoleState {
  entries: ConsoleEntry[];
  /** "running": a program or an expression is being evaluated. */
  status: "idle" | "running";
  /** File of the last run ("Run Again"). */
  file: string | null;
  startedAt: number | null;
  last: { ok: boolean; ms: number; stopped?: boolean } | null;
  history: string[];
}

export const useJsConsole = create<JsConsoleState>()(() => ({ entries: [], status: "idle", file: null, startedAt: null, last: null, history: [] }));
const set = useJsConsole.setState;
const get = useJsConsole.getState;

// ───────────── the worker ─────────────

const WORKER_SOURCE = `
const inspectValue = ${String(inspectValue)};
const refs = new Map();
let refSeq = 0;
const keep = (o) => { const id = ++refSeq; refs.set(id, o); if (refs.size > 5000) refs.delete(refs.keys().next().value); return id; };
const ser = (v) => inspectValue(v, 2, keep);
let group = 0;
const counts = Object.create(null);
const timers = Object.create(null);
const send = (m) => postMessage(m);
function fmt(args) {
  if (typeof args[0] !== "string" || !/%[sdifoOc]/.test(args[0])) return args;
  const rest = args.slice(1);
  const head = args[0].replace(/%([sdifoOc])/g, (m, k) => {
    if (!rest.length) return m;
    const v = rest.shift();
    if (k === "c") return "";
    if (k === "d" || k === "i") return String(parseInt(v, 10));
    if (k === "f") return String(parseFloat(v));
    if (k === "s") return String(v);
    rest.unshift(v);
    return "";
  });
  return [head, ...rest];
}
function emit(level, args, extra) { send(Object.assign({ type: "console", level, args: args.map(ser), group }, extra || {})); }
const con = {
  log: (...a) => emit("log", fmt(a)),
  info: (...a) => emit("info", fmt(a)),
  debug: (...a) => emit("debug", fmt(a)),
  warn: (...a) => emit("warn", fmt(a)),
  error: (...a) => emit("error", fmt(a)),
  dir: (v) => emit("log", [v]),
  dirxml: (...a) => emit("log", a),
  table: (v) => emit("log", [v]),
  trace: (...a) => emit("log", a.length ? fmt(a) : ["console.trace()"], { trace: String(new Error().stack || "").split("\\n").slice(2).join("\\n") }),
  assert: (c, ...a) => { if (!c) emit("error", ["Assertion failed:", ...fmt(a)]); },
  count: (l = "default") => { counts[l] = (counts[l] || 0) + 1; emit("log", [l + ": " + counts[l]]); },
  countReset: (l = "default") => { counts[l] = 0; },
  time: (l = "default") => { timers[l] = performance.now(); },
  timeLog: (l = "default", ...a) => emit("log", [l + ": " + (performance.now() - (timers[l] || 0)).toFixed(3) + " ms", ...a]),
  timeEnd: (l = "default") => { emit("log", [l + ": " + (performance.now() - (timers[l] || 0)).toFixed(3) + " ms"]); delete timers[l]; },
  group: (...a) => { emit("group", a.length ? fmt(a) : ["console.group"]); group++; },
  groupCollapsed: (...a) => { emit("group", a.length ? fmt(a) : ["console.group"]); group++; },
  groupEnd: () => { group = Math.max(0, group - 1); },
  clear: () => send({ type: "clear" }),
};
Object.defineProperty(self, "console", { value: con, configurable: true, writable: true });
self.addEventListener("error", (e) => { emit("error", [e.error || e.message], { uncaught: true }); e.preventDefault(); });
self.addEventListener("unhandledrejection", (e) => { emit("error", ["Uncaught (in promise)", e.reason], { uncaught: true }); e.preventDefault(); });
const require = (name) => {
  throw new Error("Cannot find module '" + name + "'. The JavaScript Console runs code like a browser does; use \\"Run with Node.js\\" for Node.js modules and npm packages.");
};
function replCode(src) {
  // Declarations stay visible to the next input, as in the devtools console.
  let code = src.replace(/^(\\s*)(?:let|const)\\s/gm, "$1var ").replace(/^(\\s*)class\\s+([A-Za-z_$][\\w$]*)/gm, "$1var $2 = class $2");
  if (/\\bawait\\b/.test(code)) {
    try { new Function("return (async () => (" + code + "))"); return "(async () => (" + code + "))()"; }
    catch (_e) { return "(async () => {" + code + "})()"; }
  }
  return code;
}
function evaluate(src) {
  const code = replCode(src);
  if (/^\\s*\\{/.test(code)) {
    try { return (0, eval)("(" + code + ")\\n//# sourceURL=<console>"); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  }
  return (0, eval)(code + "\\n//# sourceURL=<console>");
}
onmessage = async (e) => {
  const m = e.data;
  if (m.type === "run") {
    const t0 = performance.now();
    const module = { exports: {} };
    const process = {
      argv: ["node", m.file], env: {}, exitCode: 0, platform: "browser",
      exit: (c) => { throw { __exit: c == null ? 0 : c }; },
      stdout: { write: (d) => (emit("log", [String(d).replace(/\\n$/, "")]), true) },
      stderr: { write: (d) => (emit("error", [String(d).replace(/\\n$/, "")]), true) },
      nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
    };
    // A classic script at global scope: its top-level declarations stay visible to the REPL afterwards.
    Object.assign(self, { require, module, exports: module.exports, process, __filename: m.file, __dirname: m.dir });
    try {
      importScripts(m.url);
      send({ type: "done", ok: true, ms: performance.now() - t0 });
    } catch (err) {
      if (err && typeof err === "object" && "__exit" in err) send({ type: "done", ok: err.__exit === 0, code: err.__exit, ms: performance.now() - t0 });
      else { emit("error", [err], { uncaught: true }); send({ type: "done", ok: false, ms: performance.now() - t0 }); }
    }
  } else if (m.type === "eval") {
    try {
      let v = evaluate(m.code);
      if (v && typeof v.then === "function" && /\\bawait\\b/.test(m.code)) v = await v;
      send({ type: "result", id: m.id, value: ser(v) });
    } catch (err) {
      send({ type: "result", id: m.id, value: ser(err), error: true });
    }
  } else if (m.type === "expand") {
    const o = refs.get(m.ref);
    const node = o ? inspectValue(o, 1, keep) : null;
    send({ type: "expanded", id: m.id, entries: node && node.entries ? node.entries : [] });
  }
};
`;

type WorkerMessage =
  | { type: "console"; level: ConsoleLevel; args: JsValue[]; group: number; uncaught?: boolean; trace?: string }
  | { type: "clear" }
  | { type: "done"; ok: boolean; ms: number; code?: number }
  | { type: "result"; id: number; value: JsValue; error?: boolean }
  | { type: "expanded"; id: number; entries: [string, JsValue][] };

let worker: Worker | null = null;
let workerUrl: string | null = null;
let seq = 0;
let entrySeq = 0;
let pendingEval = false;
const pending = new Map<number, (data: unknown) => void>();
/** The running program: its script URL and how stack positions map back to the student's files. */
let mapping: { file: string; url: string; map: SourceMapLike | null; decoded: number[][][] | null } | null = null;

function spawn(): Worker {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const w = new Worker(workerUrl);
  w.onmessage = (e: MessageEvent) => onWorkerMessage(e.data as WorkerMessage);
  w.onerror = (e) => {
    push({ level: "error", args: [{ t: "str", v: e.message || "The console worker failed" }] });
    finish({ ok: false, ms: 0 });
  };
  return w;
}

function ensureWorker() {
  worker ??= spawn();
  return worker;
}

function onWorkerMessage(m: WorkerMessage) {
  switch (m.type) {
    case "console": {
      const args = m.args.map(fixStacks);
      if (m.uncaught && args[0]?.t === "err") args[0] = { ...args[0], name: `Uncaught ${args[0].name}` };
      push({ level: m.level, args, group: m.group, trace: m.trace ? rewriteStack(m.trace) : undefined });
      break;
    }
    case "clear":
      set({ entries: [] });
      push({ level: "system", args: [], text: "Console was cleared" });
      break;
    case "done":
      finish({ ok: m.ok, ms: m.ms }, m.code);
      break;
    case "result":
    case "expanded": {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      resolve?.(m);
      break;
    }
  }
}

function push(e: Omit<ConsoleEntry, "id" | "count" | "group"> & { group?: number }) {
  const list = get().entries;
  const last = list[list.length - 1];
  const entry: ConsoleEntry = { id: ++entrySeq, count: 1, group: 0, ...e };
  const same =
    last &&
    last.level === entry.level &&
    entry.level !== "input" &&
    entry.level !== "result" &&
    !entry.trace &&
    last.text === entry.text &&
    last.group === entry.group &&
    JSON.stringify(last.args) === JSON.stringify(entry.args);
  if (same) set({ entries: [...list.slice(0, -1), { ...last, count: last.count + 1 }] });
  else set({ entries: [...list, entry].slice(-2000) });
}

function finish(last: { ok: boolean; ms: number; stopped?: boolean }, code?: number) {
  if (get().status !== "running") return;
  const ms = Math.round(last.ms);
  const text = last.stopped ? "Stopped" : code !== undefined ? `process.exit(${code}) after ${ms} ms` : last.ok ? `Finished in ${ms} ms` : `Failed after ${ms} ms`;
  if (get().file && !pendingEval) push({ level: "system", args: [], text, outcome: last.stopped ? "stopped" : last.ok ? "ok" : "error" });
  set({ status: "idle", last: { ...last, ms }, startedAt: null });
}

// ───────────── stacks back to the student's files ─────────────

/** Rewrites positions in the program's script (a blob: URL) to "file:line:col" of the student's sources. */
export function rewriteStack(stack: string): string {
  const m = mapping;
  if (!m) return stack;
  const escaped = m.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stack.replace(new RegExp(`${escaped}:(\\d+):(\\d+)`, "g"), (all, l: string, c: string) => {
    if (m.map && m.decoded) {
      const pos = originalPosition(m.map, m.decoded, +l, +c);
      return pos ? `${pos.source}:${pos.line}:${pos.column}` : all;
    }
    return `${m.file}:${l}:${c}`;
  });
}

function fixStacks(v: JsValue): JsValue {
  if (v.t === "err") return { ...v, stack: rewriteStack(v.stack) };
  if (v.t === "obj" && v.entries) return { ...v, entries: v.entries.map(([k, x]) => [k, fixStacks(x)] as [string, JsValue]) };
  return v;
}

// ───────────── reading and bundling the program ─────────────

async function readSource(path: string): Promise<string | null> {
  const model = getDocument(path);
  if (model) return model.getValue();
  return getPlatform().fs.readFile(path).catch(() => null);
}

const RESOLVE = ["", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx", "/index.ts", "/index.js"];

/** Modules and TypeScript go through esbuild (relative imports bundled, with a source map). */
async function bundle(entry: string): Promise<{ code: string; map: SourceMapLike } | { error: string }> {
  const { ensureEsbuild, esbuild } = await import("../preview/esbuildInit");
  await ensureEsbuild();
  const resolveFile = async (importer: string, spec: string) => {
    const parts = dirname(importer).split("/").filter(Boolean);
    for (const p of spec.split("/")) {
      if (p === "..") parts.pop();
      else if (p && p !== ".") parts.push(p);
    }
    const base = parts.join("/");
    for (const ext of RESOLVE) if ((await readSource(base + ext)) !== null) return base + ext;
    return null;
  };
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2022",
      sourcemap: "external",
      outdir: "/out",
      logLevel: "silent",
      plugins: [
        {
          name: "tmcode-console",
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (args.kind === "entry-point") return { path: args.path, namespace: "ws" };
              if (/^\.{1,2}\//.test(args.path)) {
                const file = await resolveFile(args.importer, args.path);
                return file ? { path: file, namespace: "ws" } : { errors: [{ text: `Cannot find '${args.path}' (imported from ${args.importer})` }] };
              }
              // npm packages and Node.js modules stay require() calls, which explain themselves when called.
              return { path: args.path, external: true };
            });
            build.onLoad({ filter: /.*/, namespace: "ws" }, async (args) => {
              const contents = await readSource(args.path);
              if (contents === null) return { errors: [{ text: `Cannot read ${args.path}` }] };
              const ext = extname(args.path);
              const loader = ext === "ts" || ext === "mts" || ext === "cts" ? "ts" : ext === "tsx" ? "tsx" : ext === "jsx" ? "jsx" : ext === "json" ? "json" : "js";
              return { contents, loader, resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
    const raw = JSON.parse(result.outputFiles.find((f) => f.path.endsWith(".map"))?.text ?? '{"sources":[],"mappings":""}') as SourceMapLike;
    const map = { ...raw, sources: raw.sources.map((s) => s.replace(/^(\.\.\/)+/, "").replace(/^ws:/, "")) };
    return { code: js.replace(/\/\/# sourceMappingURL=.*$/m, ""), map };
  } catch (e) {
    const errors = (e as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }).errors;
    return {
      error:
        errors?.map((m) => (m.location ? `${m.location.file.replace(/^ws:/, "")}:${m.location.line}:${m.location.column + 1}: ${m.text}` : m.text)).join("\n") ??
        String((e as Error)?.message ?? e),
    };
  }
}

const needsBundle = (path: string, code: string) => /\.(ts|mts|cts|tsx|jsx)$/i.test(path) || /^\s*(import\s[^(]|import\s*\{|export\s)/m.test(code);

// ───────────── public API ─────────────

/** Runs a file in a fresh console context and shows the JavaScript Console. */
export async function runInJsConsole(path: string, opts: { reveal?: boolean } = {}) {
  await saveAll();
  const source = await readSource(path);
  if (opts.reveal !== false) showPanel("jsConsole");
  stopWorker();
  set({ entries: [], status: "running", file: path, startedAt: Date.now(), last: null });
  push({ level: "system", args: [], text: `Running ${path}` });
  log("Run", `JavaScript Console: ${path}`);
  if (source === null) {
    push({ level: "error", args: [{ t: "str", v: `Cannot read ${path}` }] });
    finish({ ok: false, ms: 0 });
    return;
  }
  let code = source;
  let map: SourceMapLike | null = null;
  if (needsBundle(path, source)) {
    const b = await bundle(path);
    if ("error" in b) {
      push({ level: "error", args: [{ t: "err", name: "Build failed", message: b.error, stack: `Build failed\n${b.error}` }] });
      finish({ ok: false, ms: 0 });
      return;
    }
    code = b.code;
    map = b.map;
  }
  if (mapping) URL.revokeObjectURL(mapping.url);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  mapping = { file: path, url, map, decoded: map ? decodeMappings(map) : null };
  pendingEval = false;
  ensureWorker().postMessage({ type: "run", url, file: path, dir: dirname(path) });
}

/** The REPL: evaluates one input in the current context (a program's globals stay visible). */
export async function evaluateInJsConsole(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return;
  set({ history: [trimmed, ...get().history.filter((h) => h !== trimmed)].slice(0, 100) });
  push({ level: "input", args: [{ t: "str", v: trimmed }] });
  const id = ++seq;
  const w = ensureWorker();
  const wasRunning = get().status === "running";
  if (!wasRunning) set({ status: "running", startedAt: Date.now() });
  pendingEval = true;
  const reply = (await new Promise((resolve) => {
    pending.set(id, resolve as (data: unknown) => void);
    w.postMessage({ type: "eval", id, code: trimmed });
  })) as Extract<WorkerMessage, { type: "result" }>;
  pendingEval = false;
  const value = fixStacks(reply.value);
  push({ level: reply.error ? "error" : "result", args: [reply.error && value.t === "err" ? { ...value, name: `Uncaught ${value.name}` } : value] });
  if (!wasRunning && get().status === "running") set({ status: "idle", startedAt: null });
}

/** Loads the children of an object that was too deep to send at once. */
export function expandRef(ref: number): Promise<[string, JsValue][]> {
  if (!worker) return Promise.resolve([]);
  const id = ++seq;
  const w = worker;
  return new Promise<[string, JsValue][]>((resolve) => {
    pending.set(id, (m) => resolve(((m as Extract<WorkerMessage, { type: "expanded" }>).entries ?? []).map(([k, v]) => [k, fixStacks(v)])));
    w.postMessage({ type: "expand", id, ref });
    setTimeout(() => {
      if (pending.delete(id)) resolve([]);
    }, 3000);
  });
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  for (const r of pending.values()) r({ type: "result", value: { t: "undef", v: "undefined" } });
  pending.clear();
}

/** Stop: ends a runaway program (an endless loop) and starts a fresh context. */
export function stopJsConsole() {
  if (get().status !== "running") return;
  stopWorker();
  finish({ ok: false, ms: Date.now() - (get().startedAt ?? Date.now()), stopped: true });
}

export function clearJsConsole() {
  set({ entries: [] });
}

export function rerunJsConsole() {
  const file = get().file;
  if (file) void runInJsConsole(file);
}

export function isJsConsoleRunning() {
  return get().status === "running";
}
