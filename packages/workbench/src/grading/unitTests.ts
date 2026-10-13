/**
 * Grading: "Run the Student's Unit Tests" on the graded version. Their project opens (read-only) if
 * it isn't already; the tests run on this computer when it has the tools, else on Task Mentor's
 * code runner. Results show in the Testing view, failures first, each with its message and file:line.
 */
import { summarize } from "@nga/runtimes/testing";
import { notify, revealView } from "../state/store";
import { useRunHub } from "../run/runHub";
import { procAvailable, runAllSuites, useFrameworkTests } from "../testing/service";
import { runUnitTestsOnServer, serverUnitAvailable, useServerUnit } from "../testing/serverUnit";
import { openSubmission, useGrading, type RosterRow } from "./service";

const isOpen = (row: RosterRow) => {
  const review = useGrading.getState().review;
  return !!review && review.project_id === row.project?.id && review.revision_id === row.link?.revision_id;
};

/** Waits for the Run hub's scan of the newly opened folder (the test suites come from it). */
async function scanned(timeoutMs = 8000) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  while (useRunHub.getState().scanning && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 100));
}

export async function runStudentUnitTests(key: string, row: RosterRow): Promise<void> {
  const name = row.student?.name ?? "The student";
  if (!isOpen(row)) {
    if (!(await openSubmission(key, row))) return;
    await scanned();
  }
  revealView("testing");
  const label = `${name}'s graded version`;
  const fw = useFrameworkTests.getState();
  if (procAvailable() && fw.suites.length) {
    await runAllSuites();
    const st = useFrameworkTests.getState().state;
    const problems = Object.values(st).filter((s) => s.problem);
    const results = Object.values(st).flatMap((s) => s.results);
    // Every suite ran (or the code runner can't help): the local results are the answer.
    if (!problems.length || !(await serverUnitAvailable())) {
      const sum = summarize(results);
      notify(sum.failed + sum.error ? "warning" : "info", results.length ? `${label}: ${sum.passed}/${sum.total} unit tests passed${sum.failed + sum.error ? `, ${sum.failed + sum.error} failed (first in the Testing view)` : ""}.` : `${label}: the unit tests did not run. See the Testing view.`, undefined, { kind: "result" });
      return;
    }
  }
  if (await serverUnitAvailable()) {
    await runUnitTestsOnServer({ label });
    const { report, error } = useServerUnit.getState();
    if (report) {
      const bad = report.failed + report.errors;
      notify(bad ? "warning" : "info", `${label}: ${report.passed}/${report.total} unit tests passed on Task Mentor${bad ? `, ${bad} failed (first in the Testing view)` : ""}.`, undefined, { kind: "result" });
    } else if (error) notify("warning", `${label}: ${error}`);
    return;
  }
  notify("info", fw.suites.length ? `This computer can't run ${name}'s unit tests, and Task Mentor can't run them yet.` : `TMCode found no unit tests in ${name}'s project.`);
}
