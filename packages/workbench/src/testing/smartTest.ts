/** The Test button (guided plan F): resolveTest's choice, run from one place, with a passed/total badge. */
import { inExam } from "../exam/state";
import { activeFilePath, getPlatform, notify, revealView, useWorkbench } from "../state/store";
import { showInputBox } from "../widgets/QuickPick";
import { currentRun } from "../run/runHub";
import { loadTests, runTests, testsFile } from "../run/testService";
import { summarize } from "@nga/runtimes/testing";
import { resolveTest, type TestChoice } from "./resolve";
import { procAvailable, runFileTests, runSuite, useFrameworkTests } from "./service";

/** What Test runs now, and why. */
export function currentTest(): TestChoice {
  const tests = useWorkbench.getState().tests;
  return resolveTest({
    samples: tests.items.length,
    samplesShipped: tests.source === "exam",
    suites: useFrameworkTests.getState().suites,
    activePath: activeFilePath(),
    exam: inExam(),
    frameworks: procAvailable(),
  });
}

/** passed/total of the choice's last results (null: not run yet). */
export function testBadge(choice: TestChoice): { passed: number; total: number; running: boolean } | null {
  if (choice.kind === "samples") {
    const { items, running } = useWorkbench.getState().tests;
    const done = items.filter((t) => t.status === "passed" || t.status === "failed" || t.status === "error");
    if (!done.length && !running) return null;
    return { passed: items.filter((t) => t.status === "passed").length, total: items.length, running: !!running };
  }
  if (choice.kind === "add") return null;
  const f = useFrameworkTests.getState();
  const running = !!f.running[choice.suiteId];
  let results = f.state[choice.suiteId]?.results ?? [];
  if (choice.kind === "file") results = results.filter((r) => r.file === choice.file);
  if (!results.length) return running ? { passed: 0, total: 0, running } : null;
  const s = summarize(results);
  return { passed: s.passed, total: s.total - s.skipped, running };
}

/** Test (status bar, palette): runs the choice; the Testing view shows the results. */
export async function runSmartTest() {
  const choice = currentTest();
  revealView("testing");
  switch (choice.kind) {
    case "samples":
      return runTests();
    case "file":
      return runFileTests(choice.file);
    case "suite":
      return runSuite(choice.suiteId);
    case "add":
      return addExampleTest();
  }
}

/**
 * Add a Test: one example (input → expected output) for the Run target, written to
 * the folder's tests file (.nga/tests.json) by TMCode (no JSON by hand), then run.
 */
export async function addExampleTest() {
  const target = currentRun().action;
  const entry = (target?.kind === "runFile" ? target.entry : null) ?? activeFilePath();
  if (!entry) return notify("info", "Open the file you want to test first.");
  const input = await showInputBox({ prompt: `Add a test for ${entry.split("/").pop()}: what does the program read? (Leave empty if it reads nothing. Use \\n for a new line.)`, placeholder: "e.g. 3\\n4" });
  if (input === undefined) return;
  const expected = await showInputBox({ prompt: "What should it print?", placeholder: "e.g. 7" });
  if (expected === undefined) return;
  const fs = getPlatform().fs;
  const file = await testsFile();
  let data: { entry: string; tests: { id: string; name: string; input: string; expected_output: string; points?: number }[] } = { entry, tests: [] };
  try {
    const old = JSON.parse(file.text ?? "") as typeof data;
    if (old?.entry === entry && Array.isArray(old.tests)) data = old;
  } catch {
    /* first test */
  }
  const n = data.tests.length + 1;
  data.tests.push({ id: String(n), name: `Example ${n}`, input: input.replace(/\\n/g, "\n"), expected_output: expected.replace(/\\n/g, "\n"), points: 1 });
  await fs.createDir(file.path.slice(0, file.path.lastIndexOf("/"))).catch(() => {});
  await fs.writeFile(file.path, JSON.stringify(data, null, 2));
  await loadTests();
  notify("info", `Added Example ${n} for ${entry.split("/").pop()}. Test runs it now and after every change.`, undefined, { owner: "add-test" });
  return runTests();
}
