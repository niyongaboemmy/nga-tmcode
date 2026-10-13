/**
 * Unit tests on Task Mentor's code runner (`POST …/code/test`): pytest, JUnit, node:test, go test…
 * run there when this computer can't (the browser build, an exam, missing tools), and in grading for
 * the student's graded version. The results have the same TestResult shape as local runs and show
 * in the Testing view, failures first.
 */
import { create } from "zustand";
import type { TestResult } from "@nga/runtimes/testing";
import { saveAll } from "../monaco/documents";
import { log, notify, revealView, useWorkbench } from "../state/store";
import { capabilities, codeErrorWords, codeTransport, runsUnitTests, unitTestsOnServer, verdictWords, type CodeFile, type CodeTransport, type UnitReport } from "../run/codeRunner";
import { collectFolder } from "../run/serverRun";
import { useRunHub } from "../run/runHub";

export interface ServerUnitState {
  status: "idle" | "running";
  /** Whose tests: "Your tests", "Ada's graded version". */
  label: string;
  report: UnitReport | null;
  /** The build's output when it failed before any test ran. */
  compile: string | null;
  error: string | null;
  ranAt: number | null;
}

export const useServerUnit = create<ServerUnitState>()(() => ({ status: "idle", label: "", report: null, compile: null, error: null, ranAt: null }));

/** What an exam's unit-test question sends (set by the exam session: the current task's files). */
export interface UnitTarget {
  question_id?: number;
  language?: string | null;
  files: CodeFile[];
}
let examTarget: (() => Promise<UnitTarget | null>) | null = null;
export function setExamUnitTarget(fn: typeof examTarget) {
  examTarget = fn;
}

/** The workspace's language for the runner: the project the Run hub found (its catalog kind). */
function workspaceLanguage(): string | null {
  const p = useRunHub.getState().projects.find((x) => x.catalogKind);
  return p?.catalogKind?.split("/")[0] ?? null;
}

/** Whether Task Mentor can run unit tests here now (for showing the button at all). */
export async function serverUnitAvailable(language: string | null = workspaceLanguage()): Promise<boolean> {
  return runsUnitTests(await capabilities(), language);
}

/** Failures first (then errors, passed, skipped), each group in file and line order. */
export function failuresFirst(results: TestResult[]): TestResult[] {
  const rank = (s: TestResult["status"]) => (s === "failed" ? 0 : s === "error" ? 1 : s === "passed" ? 2 : 3);
  return [...results].sort((a, b) => rank(a.status) - rank(b.status) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Runs unit tests on Task Mentor. In an exam: the current task's files (its own question); else
 * `files` when given (grading: the student's graded version), else the open folder. False when the
 * code runner can't (not signed in, an older Task Mentor, unit tests off).
 */
export async function runUnitTestsOnServer(opts: { files?: CodeFile[]; language?: string | null; label?: string; transport?: CodeTransport | null } = {}): Promise<boolean> {
  const t = opts.transport ?? codeTransport();
  const caps = await capabilities(t);
  let target: UnitTarget | null = null;
  if (t?.where === "exam") target = (await examTarget?.()) ?? null;
  const language = opts.language ?? target?.language ?? workspaceLanguage();
  if (!t || !runsUnitTests(caps, language)) {
    notify("info", t ? "Task Mentor can't run these unit tests yet." : "Sign in to Task Mentor to run unit tests there.");
    return false;
  }
  if (useServerUnit.getState().status === "running") return true;
  await saveAll();
  const label = opts.label ?? "Your tests";
  useServerUnit.setState({ status: "running", label, error: null });
  revealView("testing");
  try {
    let files = opts.files ?? target?.files;
    if (!files) {
      const root = useWorkbench.getState().workspace ? "" : null;
      if (root === null) throw new Error("Open a folder first.");
      files = (await collectFolder(root)).files;
    }
    if (!files.length) throw new Error("There are no files to test.");
    const res = await unitTestsOnServer(t, { language, files, ...(target?.question_id ? { question_id: target.question_id } : {}) });
    const report = res.unit;
    const compile = report && report.verdict !== "passed" && report.verdict !== "failed" ? (report.output || res.compile?.output || null) : null;
    useServerUnit.setState({ status: "idle", report, compile, error: report ? null : (res.error ?? "Task Mentor ran no tests."), ranAt: Date.now() });
    if (report) log("Tests", `${label}: ${report.passed}/${report.total} unit tests passed on Task Mentor (${report.framework ?? "unknown framework"}, ${report.verdict})`);
  } catch (e) {
    const message = (e as { code?: string })?.code ? codeErrorWords(e) : String((e as Error)?.message ?? e);
    useServerUnit.setState({ status: "idle", error: message, ranAt: Date.now() });
  }
  return true;
}

/** One line for a report that has no test results: why (in plain words). */
export function reportProblem(r: UnitReport | null): string | null {
  if (!r || r.tests.length) return null;
  if (r.verdict === "passed") return "No tests were found.";
  return verdictWords(r.verdict === "error" ? "compile-error" : r.verdict) ?? "The tests did not run.";
}

/** Forgets the results (a new folder, a new student). */
export function clearServerUnit() {
  useServerUnit.setState({ status: "idle", label: "", report: null, compile: null, error: null, ranAt: null });
}
