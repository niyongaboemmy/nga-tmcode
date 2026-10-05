import type { FileSystem, RunEvent, RunHandle, RunRequest, Runner } from "./types";

/**
 * Browser fallback for JavaScript (profile fallback "js-worker"): the program
 * runs in a throwaway Web Worker with a small Node-like surface — console,
 * process.stdout/stderr, require("fs").readFileSync(0) for stdin, and a
 * minimal readline — which covers typical exercises that read input.
 * There is no file system or network module; the worker is terminated on
 * timeout or Stop.
 */

const WORKER_SOURCE = String.raw`
const send = (type, data) => postMessage({ type, data });
const fmt = (args) => args.map((a) => {
  if (typeof a === "string") return a;
  try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch { return String(a); }
}).join(" ");
onmessage = (e) => {
  const { code, stdin, file } = e.data;
  let stdinLeft = stdin;
  const lines = stdin.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const out = (d) => send("stdout", String(d));
  const err = (d) => send("stderr", String(d));
  const console = {
    log: (...a) => out(fmt(a) + "\n"), info: (...a) => out(fmt(a) + "\n"),
    warn: (...a) => err(fmt(a) + "\n"), error: (...a) => err(fmt(a) + "\n"), debug: (...a) => out(fmt(a) + "\n"),
  };
  const process = {
    stdout: { write: (d) => (out(d), true) }, stderr: { write: (d) => (err(d), true) },
    argv: ["node", file], env: {}, exitCode: 0,
    exit: (c) => { throw { __exit: c ?? 0 }; },
    stdin: { on() {}, setEncoding() {}, resume() {} },
  };
  const modules = {
    // Like Node: stdin can be read once; later reads see end-of-file.
    fs: { readFileSync: (fd) => { if (fd === 0 || fd === "/dev/stdin") { const s = stdinLeft; stdinLeft = ""; return s; } throw new Error("fs is not available when running in the browser"); } },
    readline: {
      createInterface: () => {
        const handlers = {};
        const rl = {
          on(ev, fn) { handlers[ev] = fn; if (ev === "close") queueMicrotask(flush); return rl; },
          question(q, cb) { out(q); cb(lines.shift() ?? ""); },
          close() {},
          [Symbol.asyncIterator]: async function* () { while (lines.length) yield lines.shift(); },
        };
        let flushed = false;
        function flush() {
          if (flushed) return; flushed = true;
          while (lines.length && handlers.line) handlers.line(lines.shift());
          handlers.close && handlers.close();
        }
        queueMicrotask(() => queueMicrotask(flush));
        return rl;
      },
    },
  };
  const require = (name) => {
    const m = modules[name.replace(/^node:/, "")];
    if (!m) throw new Error("Cannot find module '" + name + "' (only fs and readline are available in the browser)");
    return m;
  };
  const module = { exports: {} };
  let code_ = 0;
  try {
    new Function("console", "process", "require", "module", "exports", code)(console, process, require, module, module.exports);
  } catch (ex) {
    if (ex && typeof ex === "object" && "__exit" in ex) code_ = ex.__exit;
    else { err((ex && ex.stack) || String(ex)); code_ = 1; }
  }
  setTimeout(() => postMessage({ type: "exit", data: code_ || process.exitCode || 0 }), 0);
};
`;

let workerUrl: string | null = null;

export function createJsWorkerRunner(fs: FileSystem): Runner {
  return {
    interactive: false,
    async detect() {
      return [{ tool: "node", path: "browser", version: "JavaScript (in-browser sandbox)" }];
    },
    async start(req: RunRequest, onEvent: (e: RunEvent) => void): Promise<RunHandle> {
      if (req.run.tool !== "node" || req.build.length) {
        throw new Error("Only JavaScript can run in the browser. Use the TMCode desktop app for other languages.");
      }
      const code = await fs.readFile(req.entry);
      workerUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const worker = new Worker(workerUrl);
      const started = performance.now();
      let done = false;
      let total = 0;
      const limit = (req.output_limit_kb ?? 256) * 1024;
      const finish = (code: number | null, extra: Partial<Extract<RunEvent, { type: "exit" }>> = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.terminate();
        onEvent({
          type: "exit",
          phase: "run",
          code,
          timed_out: false,
          truncated: false,
          killed: false,
          duration_ms: Math.round(performance.now() - started),
          ...extra,
        });
      };
      const timer = setTimeout(() => finish(null, { timed_out: true }), req.timeout_ms ?? 10_000);
      worker.onmessage = (e: MessageEvent<{ type: string; data: string | number }>) => {
        const { type, data } = e.data;
        if (type === "exit") return finish(Number(data));
        const text = String(data);
        total += text.length;
        if (total > limit) return finish(null, { truncated: true });
        onEvent({ type: type === "stderr" ? "stderr" : "stdout", data: text });
      };
      worker.onerror = (e) => {
        onEvent({ type: "stderr", data: `${e.message}\n` });
        finish(1);
      };
      onEvent({ type: "step", phase: "run", command: `node ${req.entry.split("/").pop()} (browser sandbox)` });
      worker.postMessage({ code, stdin: req.stdin ?? "", file: req.entry });
      return { input: () => {}, kill: () => finish(null, { killed: true }) };
    },
  };
}
