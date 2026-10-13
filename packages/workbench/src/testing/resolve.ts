/**
 * One Test (guided plan F): what the Test button tests, with the reason, by one rule — like Run's
 * resolveRun. Pure and unit-tested.
 */
import { isTestFile, suiteForFile, type TestSuite } from "@nga/runtimes/testing";

export type TestChoice =
  | { kind: "samples"; label: string; reason: string }
  | { kind: "file"; suiteId: string; file: string; label: string; reason: string }
  | { kind: "suite"; suiteId: string; label: string; reason: string }
  | { kind: "add"; label: string; reason: string };

export interface TestInput {
  /** Example tests (input → expected output) of the exam task or .tmcode/tests.json. */
  samples: number;
  /** They come from the exam or the assignment (not a file the student made). */
  samplesShipped: boolean;
  suites: TestSuite[];
  activePath: string | null;
  exam: boolean;
  /** Framework tests can run here (the desktop app, not in an exam). */
  frameworks: boolean;
}

const name = (path: string) => path.split("/").pop() ?? path;

export function resolveTest(i: TestInput): TestChoice {
  // 1. The exam's or the assignment's own examples: what the teacher checks.
  if (i.samples > 0 && (i.exam || i.samplesShipped)) return { kind: "samples", label: "Example Tests", reason: i.exam ? "they are this task's example tests" : "your teacher gave these example tests" };
  if (i.frameworks && i.activePath) {
    const suite = suiteForFile(i.suites, i.activePath);
    // 2. A test file: its tests.
    if (suite && isTestFile(i.activePath)) return { kind: "file", suiteId: suite.id, file: i.activePath, label: `Test ${name(i.activePath)}`, reason: "it's the test file you're editing" };
    // 3. The file's project has a test framework: that project's tests.
    if (suite) return { kind: "suite", suiteId: suite.id, label: `Test ${suite.label.split(" · ")[0]}`, reason: `${suite.dir || "this folder"} uses ${suite.label.split(" · ")[0]}` };
  }
  if (i.frameworks && i.suites.length === 1) return { kind: "suite", suiteId: i.suites[0].id, label: `Test ${i.suites[0].label.split(" · ")[0]}`, reason: "it's the only test suite here" };
  // 4. Examples the student wrote, else a way to add one.
  if (i.samples > 0) return { kind: "samples", label: "Example Tests", reason: "they are this folder's example tests" };
  return { kind: "add", label: "Add a Test", reason: "there are no tests here yet: add an example input and the output you expect" };
}
