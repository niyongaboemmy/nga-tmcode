/**
 * Running on Task Mentor when this computer can't: a live run in the Run panel (output as it comes,
 * typed input, Ctrl+C, End of Input, Stop), the example tests of `.nga/tests.json`, and unit tests.
 * Everything here asks the code runner's capabilities first and does nothing when they are missing.
 */
import { finishRun, recordRun, runEndOf } from "./runActivity";
import { saveAll } from "../monaco/documents";
import type { RunEvent, RunHandle } from "../platform/types";
import { getPlatform, log, notify, setTests, updateTest, useWorkbench } from "../state/store";
import { basename, dirname } from "../util/paths";
import { capabilities, codeErrorWords, codeTransport, runOnServer, startSession, verdictWords, type CodeFile, type CodeRunnerError, type RemoteSession, type SessionEvent } from "./codeRunner";
import { outputsMatch } from "@tmcode/protocol";
import { useServerRun } from "./testService";
import { fileKind } from "./catalogRun";
import { useRunHub } from "./runHub";
import { attachDebuggeeRun, sendRunInput, writeConsole } from "./runService";

/** Task Mentor's limits for one run: 100 files, 1 MB. */
export const MAX_FILES = 100;
export const MAX_BYTES = 1024 * 1024;

/** Folders never sent: tools' output and caches (Task Mentor ignores them anyway). */
const SKIP = new Set([".git", ".tmcode", "node_modules", ".venv", "venv", "__pycache__", "build", "dist", "target", "bin", "obj", ".gradle", ".idea", ".vscode", ".dart_tool", "vendor"]);

/**
 * The files a run on Task Mentor needs: the project the entry belongs to (the Run hub's folder for
 * it), else the entry's own folder; paths relative to that folder. Binary files and caches are left
 * out; a folder over Task Mentor's limits sends what fits, entry first.
 */
export async function collectRunFiles(entry: string): Promise<{ root: string; entry: string; files: CodeFile[]; kind: string | null; skipped: number }> {
  // A real project (a manifest: package.json, pom.xml…) is sent whole; loose exercises one folder at a time.
  const owner = useRunHub
    .getState()
    .projects.filter((p) => !p.loose && (p.dir === "" || entry.startsWith(`${p.dir}/`)))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  const root = owner?.dir ?? dirname(entry);
  const { files, skipped } = await collectFolder(root, entry);
  return { root, entry: root ? entry.slice(root.length + 1) : entry, files, kind: owner?.catalogKind ?? null, skipped };
}

/** A folder's text files, relative to it, within Task Mentor's limits (`first` always fits). */
export async function collectFolder(root: string, first?: string): Promise<{ files: CodeFile[]; skipped: number }> {
  const rel = (p: string) => (root ? p.slice(root.length + 1) : p);
  const fs = getPlatform().fs;
  const paths: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (paths.length > 400 || depth > 8) return;
    const list = await fs.readDir(dir).catch(() => []);
    for (const e of list) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === "dir") {
        if (!SKIP.has(e.name)) await walk(path, depth + 1);
      } else paths.push(path);
    }
  };
  await walk(root, 0);
  paths.sort((a, b) => Number(b === first) - Number(a === first));
  const files: CodeFile[] = [];
  let bytes = 0;
  let skipped = 0;
  for (const p of paths) {
    if (files.length >= MAX_FILES) {
      skipped++;
      continue;
    }
    const content = await fs.readFile(p).catch(() => null);
    if (content === null || content.includes("\u0000")) continue;
    const size = new TextEncoder().encode(content).length;
    if (bytes + size > MAX_BYTES) {
      skipped++;
      continue;
    }
    bytes += size;
    files.push({ path: rel(p), content });
  }
  return { files, skipped };
}

/** The catalog language of a file ("python", "haskell"…), for the runner. */
export function languageOf(entry: string, source?: string | null): string | null {
  return fileKind(basename(entry), source)?.language ?? null;
}

/** Whether a live run on Task Mentor is possible now (signed in or in an exam, and the runner allows it). */
export async function canRunOnTaskMentor(): Promise<boolean> {
  return !!(await capabilities())?.interactive;
}

/** Lone `\n` → `\r\n` (the console is a terminal). */
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/**
 * A RunHandle for a session: typing goes to a line that is echoed and sent on Enter (the program
 * reads lines through a pipe, not a terminal), Ctrl+C interrupts, Ctrl+D ends the input.
 */
export function remoteHandle(session: RemoteSession, echo: (text: string) => void): RunHandle & { stopped(): boolean } {
  let line = "";
  let stopped = false;
  const report = (p: Promise<void>) => p.catch((e) => writeConsole({ type: "error", message: codeErrorWords(e) }));
  return {
    input(data: string) {
      for (const ch of data) {
        if (ch === "\x03") {
          echo("^C\r\n");
          line = "";
          void report(session.interrupt());
        } else if (ch === "\x04") {
          if (line) void report(session.input(line));
          line = "";
          void report(session.eof());
        } else if (ch === "\r" || ch === "\n") {
          echo("\r\n");
          void report(session.input(`${line}\n`));
          line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (line) {
            line = line.slice(0, -1);
            echo("\b \b");
          }
        } else if (ch >= " ") {
          line += ch;
          echo(ch);
        }
      }
    },
    kill() {
      stopped = true;
      void session.stop();
    },
    stopped: () => stopped,
  };
}

let session: RemoteSession | null = null;
let handle: (RunHandle & { stopped(): boolean }) | null = null;

/** The Run panel's buttons for a run on Task Mentor. */
export function sendRemoteLine(text: string) {
  sendRunInput(`${text}\r`);
}
export function interruptRemoteRun() {
  sendRunInput("\x03");
}
export function endRemoteInput() {
  sendRunInput("\x04");
}

/**
 * Runs `entry` on Task Mentor in the Run panel. `why` is the first line ("This computer doesn't
 * have GHC, so Main.hs runs on Task Mentor."). False when Task Mentor can't run it live.
 */
export async function runOnTaskMentor(entry: string, why?: string): Promise<boolean> {
  const t = codeTransport();
  const caps = await capabilities(t);
  if (!t || !caps?.interactive) {
    notify("info", t ? "Task Mentor can't run programs live yet. Run the tests instead, or install the language's tools." : "Sign in to Task Mentor to run programs there.");
    return false;
  }
  await saveAll();
  const fs = getPlatform().fs;
  const source = await fs.readFile(entry).catch(() => null);
  const pack = await collectRunFiles(entry);
  if (!pack.files.length) {
    notify("warning", `There is nothing to send for '${basename(entry)}'.`);
    return false;
  }
  const language = languageOf(entry, source);
  const label = `${basename(entry)} on Task Mentor`;
  writeConsole({ type: "clear" });
  writeConsole({ type: "info", text: `▶ ${why ?? `${basename(entry)} runs on Task Mentor.`}` });
  writeConsole({ type: "info", text: "Type your input below and press Enter. Ctrl+C stops the program; End of Input closes its input." });
  if (pack.skipped) writeConsole({ type: "info", text: `${pack.skipped} file(s) were too many or too large to send.` });
  log("Run", `Run ${entry} on Task Mentor (${pack.files.length} files, ${language ?? pack.kind ?? "detected"})`);
  const activity = recordRun({ kind: "run", action: "run", path: entry, text: `Ran ${entry} on Task Mentor`, data: { where_run: "Task Mentor", files: pack.files.length, language: language ?? pack.kind ?? "detected" } });
  finishRun(activity, { status: "running" });
  const started = Date.now();
  let phase: "build" | "run" = "run";
  try {
    await attachDebuggeeRun(
      label,
      entry,
      async (onEvent: (e: RunEvent) => void) => {
        const toRun = (e: SessionEvent) => {
          switch (e.type) {
            case "stage":
              phase = e.name;
              if (e.name === "build") onEvent({ type: "step", phase: "build", command: "Building on Task Mentor…" });
              else {
                useWorkbench.setState((s) => ({ run: { ...s.run, status: "running", startedAt: Date.now() } }));
              }
              return;
            case "stdout":
            case "stderr":
              return onEvent({ type: e.type, data: crlf(e.data) });
            case "error":
              return onEvent({ type: "error", message: e.message });
            case "exit": {
              const stoppedByUser = handle?.stopped() ?? false;
              const failedBuild = phase === "build" && (e.verdict === "compile-error" || e.verdict === "package-not-available");
              if (!stoppedByUser && e.verdict !== "ok" && !(e.verdict === "runtime-error" && e.code !== null)) {
                onEvent({ type: "error", message: verdictWords(e.verdict) ?? e.verdict });
              }
              if (failedBuild) onEvent({ type: "exit", phase: "build", code: e.code ?? 1, timed_out: false, truncated: false, killed: false, duration_ms: e.time_ms ?? Date.now() - started });
              session = null;
              const exit = {
                type: "exit" as const,
                phase: "run" as const,
                code: e.code,
                timed_out: e.verdict === "time-limit",
                truncated: e.verdict === "output-limit",
                killed: stoppedByUser || e.signal === "SIGINT" || e.signal === "SIGTERM",
                duration_ms: e.time_ms ?? Date.now() - started,
              };
              finishRun(activity, failedBuild ? runEndOf({ ...exit, phase: "build", code: e.code ?? 1 }) : runEndOf(exit));
              return onEvent(exit);
            }
          }
        };
        session = await startSession(t, { language, kind: pack.kind, entry: pack.entry, files: pack.files }, toRun);
        handle = remoteHandle(session, (text) => writeConsole({ type: "stdout", data: text }));
        return handle;
      },
      { state: { status: "building", entry, remote: true }, keepConsole: true },
    );
    return true;
  } catch (e) {
    writeConsole({ type: "error", message: codeErrorWords(e) });
    finishRun(activity, { status: "error" });
    return true;
  }
}

/** A run on Task Mentor is going on (the Run panel's input line shows). */
export const remoteRunActive = () => !!session;

/** Task Mentor runs at most 10 tests per request. */
const TESTS_PER_RUN = 10;

/**
 * The example tests of `.nga/tests.json` on Task Mentor's code runner (outside exams), when this
 * computer can't run them. Results go to the Testing view like local ones. False when the code
 * runner isn't there (signed out, an older Task Mentor): the caller says what it said before.
 */
export async function runExampleTestsOnServer(ids?: string[]): Promise<boolean> {
  const t = codeTransport();
  if (!t || t.where === "exam" || !(await capabilities(t))) return false;
  const { tests } = useWorkbench.getState();
  if (!tests.entry) return false;
  const retryAt = useServerRun.getState().retryAt;
  if (retryAt && retryAt > Date.now()) {
    notify("info", `Too many runs on Task Mentor. Run again in ${Math.ceil((retryAt - Date.now()) / 1000)} s.`);
    return true;
  }
  const selected = tests.items.filter((x) => !ids || ids.includes(x.id));
  if (!selected.length) return true;
  useServerRun.setState({ remote: true, status: "queued", error: null });
  for (const x of selected) updateTest(x.id, { status: "queued", message: "Running on Task Mentor…", actual: undefined, stderr: undefined, duration_ms: undefined, verdict: undefined });
  setTests({ running: true });
  try {
    const source = await getPlatform().fs.readFile(tests.entry).catch(() => null);
    const pack = await collectRunFiles(tests.entry);
    const language = languageOf(tests.entry, source);
    let passed = 0;
    for (let i = 0; i < selected.length; i += TESTS_PER_RUN) {
      const batch = selected.slice(i, i + TESTS_PER_RUN);
      const res = await runOnServer(t, {
        language,
        kind: pack.kind,
        entry: pack.entry,
        files: pack.files,
        tests: batch.map((x) => ({ id: x.id, input: x.input, expected_output: x.expected_output })),
      });
      const byId = new Map(res.tests.map((r) => [r.id, r]));
      for (const x of batch) {
        const r = byId.get(x.id);
        if (!r) {
          updateTest(x.id, { status: "error", message: res.error ?? res.compile?.output?.split("\n")[0] ?? "Task Mentor did not run this test." });
          continue;
        }
        // The runner compares when it was given the expected output; else TMCode does, as for local runs.
        const ran = r.verdict === "ok" || r.verdict === "accepted" || r.verdict === "wrong-answer";
        const ok = r.passed === true || (r.passed === null && r.verdict === "ok" && outputsMatch(r.stdout, x.expected_output));
        if (ok) passed++;
        updateTest(x.id, {
          status: ok ? "passed" : ran ? "failed" : "error",
          verdict: ok ? "passed" : ran ? "wrong-answer" : r.verdict,
          actual: r.stdout,
          stderr: r.stderr,
          duration_ms: typeof r.time_ms === "number" ? r.time_ms : undefined,
          message: ok ? "Passed on Task Mentor" : `${ran ? "Output does not match" : (verdictWords(r.verdict) ?? "Failed")} (on Task Mentor)`,
        });
      }
    }
    log("Tests", `${passed}/${selected.length} example tests passed (run on Task Mentor)`);
    useServerRun.setState({ status: "idle", lastRunAt: Date.now() });
  } catch (e) {
    const err = e as CodeRunnerError;
    const message = codeErrorWords(e);
    if (err?.code === "RATE_LIMITED") {
      const secs = Number(err.data?.retry_after_s) > 0 ? Math.ceil(Number(err.data.retry_after_s)) : 60;
      useServerRun.setState({ retryAt: Date.now() + secs * 1000 });
    }
    for (const x of selected) updateTest(x.id, { status: "idle", message });
    useServerRun.setState({ status: "idle", error: message });
    log("Tests", `Run on Task Mentor failed: ${err?.code ?? ""} ${message}`, "warn");
  } finally {
    setTests({ running: false });
  }
  return true;
}
