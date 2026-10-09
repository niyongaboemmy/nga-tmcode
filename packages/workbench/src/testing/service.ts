import { create } from "zustand";
import { inExam } from "../exam/state";
import { getDocument, saveAll } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import { revealInEditor } from "../monaco/reveal";
import { useRunHub } from "../run/runHub";
import { getPlatform, log, notify, showPanel, useWorkbench } from "../state/store";
import { detectSuites, setShellOs, suiteForFile, testAt, type Scope, type TestSuite } from "./frameworks";
import { summarize, type TestResult } from "./parsers";
import { parseRun } from "./report";

/**
 * Framework tests (pytest, Vitest, Jest, node:test, JUnit via Maven/Gradle,
 * go test, cargo test, dart/flutter test, PHPUnit, RSpec, dotnet test, swift
 * test): the suites come from the Run hub's folder scan, each run is a real
 * command through the platform's proc host, and its machine-readable report
 * fills the Testing view and puts failures on their lines in the editor.
 */

export const OUTPUT_CHANNEL = "Tests";
const MARKER_OWNER = "tmcode-tests";

export interface SuiteRun {
  /** What is running: "all", a file or a test name. */
  scope: string;
  procId: number | null;
  startedAt: number;
}

export interface SuiteState {
  results: TestResult[];
  /** Raw output of the last run (shown when there is no report). */
  output: string;
  exitCode: number | null;
  finishedAt: number | null;
  /** The run produced no report (command missing, compile error …). */
  problem: string | null;
}

interface FrameworkTestsState {
  suites: TestSuite[];
  state: Record<string, SuiteState>;
  running: Record<string, SuiteRun>;
}

export const useFrameworkTests = create<FrameworkTestsState>()(() => ({ suites: [], state: {}, running: {} }));
const set = useFrameworkTests.setState;
const get = useFrameworkTests.getState;

export const procAvailable = () => !!getPlatform().proc && !inExam();

let wired = false;
/** Keeps the suites in step with the Run hub's scan. */
export function wireFrameworkTests() {
  if (wired) return;
  wired = true;
  setShellOs(getPlatform().os);
  let folders = useRunHub.getState().folders;
  set({ suites: detectSuites(folders) });
  useRunHub.subscribe((s) => {
    if (s.folders === folders) return;
    folders = s.folders;
    const suites = detectSuites(folders);
    const ids = new Set(suites.map((x) => x.id));
    set({ suites, state: Object.fromEntries(Object.entries(get().state).filter(([k]) => ids.has(k))) });
  });
  let root = useWorkbench.getState().workspace?.root;
  useWorkbench.subscribe((s) => {
    if (s.workspace?.root === root) return;
    root = s.workspace?.root;
    for (const r of Object.values(get().running)) if (r.procId !== null) void getPlatform().proc?.kill(r.procId);
    clearAllMarkers();
    set({ state: {}, running: {} });
  });
}

const absRoot = (dir: string) => {
  const root = useWorkbench.getState().workspace?.root ?? "";
  return dir ? `${root}/${dir}` : root;
};

async function readReport(suite: TestSuite): Promise<string[] | null> {
  const { fs } = getPlatform();
  const path = suite.report.path;
  if (!path) return null;
  if (suite.report.kind === "junit-dir") {
    const entries = await fs.readDir(path).catch(() => []);
    const xml = entries.filter((e) => e.kind === "file" && /^TEST-.*\.xml$/.test(e.name));
    return Promise.all(xml.map((e) => fs.readFile(`${path}/${e.name}`).catch(() => "")));
  }
  const text = await fs.readFile(path).catch(() => null);
  return text === null ? null : [text];
}

function scopeLabel(scope?: Scope) {
  return scope?.test ? scope.test.name : scope?.file ? scope.file : "all";
}

/** Merges a partial run into the previous results (same test id → replaced). */
function merge(prev: TestResult[], next: TestResult[], scope?: Scope) {
  if (!scope) return next;
  // Tools report the tests they filtered out as skipped: only the chosen test's result counts.
  if (scope.test) next = next.filter((r) => r.name === scope.test!.name || r.status !== "skipped");
  const ids = new Set(next.map((r) => r.id));
  const kept = prev.filter((r) => !ids.has(r.id) && !(scope.file && !scope.test && r.file === scope.file));
  return [...kept, ...next];
}

export async function runSuite(suiteId: string, scope?: Scope) {
  const suite = get().suites.find((s) => s.id === suiteId);
  const proc = getPlatform().proc;
  if (!suite) return;
  if (!proc) return notify("warning", "Framework tests need the TMCode desktop app.");
  if (inExam()) return notify("warning", "Running test commands is turned off during exams.");
  if (get().running[suiteId]) return;
  await saveAll();
  const { fs } = getPlatform();
  if (suite.report.path) {
    // A stale report must never pass for this run's results.
    await fs.remove(suite.report.path).catch(() => {});
    await ensureDir(suite.report.kind === "junit-dir" ? suite.report.path : suite.report.path.replace(/\/[^/]+$/, ""));
  }
  const command = suite.command(scope);
  log(OUTPUT_CHANNEL, `▶ ${suite.label}: ${command}${suite.dir ? `   (in ${suite.dir})` : ""}`);
  let output = "";
  const startedAt = Date.now();
  set({ running: { ...get().running, [suiteId]: { scope: scopeLabel(scope), procId: null, startedAt } } });
  let line = "";
  const flushLine = (data: string) => {
    line += data;
    const parts = line.split("\n");
    line = parts.pop() ?? "";
    // Machine output (go test -json, dart --reporter json) is parsed, not logged.
    for (const p of parts) if (!(suite.report.kind === "go" || suite.report.kind === "dart") || !p.startsWith("{")) log(OUTPUT_CHANNEL, p);
  };
  const finished = new Promise<number | null>((resolve) => {
    proc
      .run(command, suite.dir, (e) => {
        if (e.type === "exit") {
          if (line) log(OUTPUT_CHANNEL, line);
          resolve(e.code);
          return;
        }
        output += e.data;
        flushLine(e.data);
      })
      .then((procId) => {
        const r = get().running[suiteId];
        if (r) set({ running: { ...get().running, [suiteId]: { ...r, procId } } });
      })
      .catch((err) => {
        output += String((err as Error)?.message ?? err);
        resolve(null);
      });
  });
  const exitCode = await finished;
  const results = parseRun(suite, await readReport(suite), output, absRoot(suite.dir));
  const prev = get().state[suiteId]?.results ?? [];
  const running = { ...get().running };
  delete running[suiteId];
  const problem = results ? null : explain(suite, exitCode, output);
  const merged = results ? merge(prev, results, scope) : prev;
  set({ running, state: { ...get().state, [suiteId]: { results: merged, output, exitCode, finishedAt: Date.now(), problem } } });
  const sum = summarize(results ?? []);
  log(OUTPUT_CHANNEL, results ? `■ ${sum.passed} passed, ${sum.failed + sum.error} failed, ${sum.skipped} skipped (${((Date.now() - startedAt) / 1000).toFixed(1)} s)` : `■ ${problem}`, results && !sum.failed && !sum.error ? "info" : "warn");
  applyMarkers();
  if (!results) showPanel("output");
  return results;
}

function explain(suite: TestSuite, code: number | null, output: string) {
  if (code === 127 || /command not found|is not recognized|No module named pytest|Cannot find module/i.test(output)) {
    return `The test command is not installed.${suite.install ? ` Install it with: ${suite.install}` : ""}`;
  }
  if (code === 5 && suite.framework === "pytest") return "pytest found no tests (name files test_*.py and functions test_*).";
  return code === null ? "The tests were stopped." : `The tests did not produce a report (exit code ${code}). See the Output panel.`;
}

async function ensureDir(path: string) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) await getPlatform().fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
}

export function stopSuite(suiteId: string) {
  const r = get().running[suiteId];
  if (r?.procId != null) void getPlatform().proc?.kill(r.procId);
}

export async function runAllSuites() {
  await Promise.all(get().suites.map((s) => runSuite(s.id)));
}

// ───────────── editor ─────────────

const marked = new Set<string>();
function clearAllMarkers() {
  for (const path of marked) {
    const model = getDocument(path);
    if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }
  marked.clear();
}

/** Failing tests as error markers on their lines (Problems panel + squiggles). */
export function applyMarkers() {
  const byFile = new Map<string, TestResult[]>();
  for (const st of Object.values(get().state)) {
    for (const r of st.results) if ((r.status === "failed" || r.status === "error") && r.file && r.line) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  }
  for (const path of marked) if (!byFile.has(path)) getDocument(path) && monaco.editor.setModelMarkers(getDocument(path)!, MARKER_OWNER, []);
  marked.clear();
  for (const [path, rs] of byFile) {
    const model = getDocument(path);
    if (!model) continue;
    marked.add(path);
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      rs.map((r) => {
        const line = Math.min(model.getLineCount(), r.line!);
        return { severity: monaco.MarkerSeverity.Error, message: `${r.name}: ${r.message ?? "failed"}`, startLineNumber: line, startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line), source: "Tests" };
      }),
    );
  }
}

export function revealResult(r: TestResult) {
  if (r.file) revealInEditor(r.file, r.line ?? undefined);
}

// ───────────── commands ─────────────

export function suiteOfFile(path: string | null) {
  return path ? suiteForFile(get().suites, path) : null;
}

/** The test at the cursor of `path` (or the whole file when the cursor isn't in a test). */
export async function runTestAt(path: string, line: number) {
  const suite = suiteOfFile(path);
  if (!suite) return notify("info", "No test framework was found for this file.");
  const model = getDocument(path);
  const name = model ? testAt(model.getValue(), line, path) : null;
  const known = name ? Object.values(get().state).flatMap((s) => s.results).find((r) => r.name === name && (!r.file || r.file === path)) : undefined;
  return runSuite(suite.id, name ? { file: path, test: { name, group: known?.group ?? "" } } : { file: path });
}

export function runFileTests(path: string) {
  const suite = suiteOfFile(path);
  if (!suite) return notify("info", "No test framework was found for this file.");
  return runSuite(suite.id, { file: path });
}

export function failedResults() {
  return Object.entries(get().state).flatMap(([suite, st]) => st.results.filter((r) => r.status === "failed" || r.status === "error").map((r) => ({ suite, r })));
}

/** Re-runs each failed test (one command per suite when it fails in one file, else the whole suite). */
export async function rerunFailed() {
  const bySuite = new Map<string, TestResult[]>();
  for (const { suite, r } of failedResults()) bySuite.set(suite, [...(bySuite.get(suite) ?? []), r]);
  await Promise.all(
    [...bySuite].map(([suite, rs]) =>
      rs.length === 1 ? runSuite(suite, { file: rs[0].file ?? undefined, test: { name: rs[0].name, group: rs[0].group } }) : runSuite(suite),
    ),
  );
}
