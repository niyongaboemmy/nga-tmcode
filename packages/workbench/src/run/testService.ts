import { profileForPath } from "@tmcode/profiles";
import { outputsMatch } from "@tmcode/protocol";
import { saveAll } from "../monaco/documents";
import { getPlatform, log, notify, openEditorInput, setTests, updateTest, useWorkbench, type TestItem } from "../state/store";
import { startRun } from "./runService";

/**
 * Visible tests (plan §8.1): run locally for feedback only. In practice mode
 * they come from `.tmcode/tests.json`; in an exam, from the Task Mentor
 * package. Local results are advisory — the grade is a server re-run.
 */
export const TESTS_FILE = ".tmcode/tests.json";

interface TestsFile {
  entry: string;
  tests: { id: string; name?: string; input: string; expected_output: string }[];
}

export async function loadTests() {
  const fs = getPlatform().fs;
  let raw: string;
  try {
    raw = await fs.readFile(TESTS_FILE);
  } catch {
    setTests({ entry: null, items: [], source: null });
    return;
  }
  try {
    const data = JSON.parse(raw) as TestsFile;
    if (!data.entry || !Array.isArray(data.tests)) throw new Error("expected { entry, tests: [...] }");
    setTests({
      entry: data.entry,
      source: TESTS_FILE,
      items: data.tests.map((t, i) => ({
        id: String(t.id ?? i + 1),
        name: t.name || `Test ${i + 1}`,
        input: String(t.input ?? ""),
        expected_output: String(t.expected_output ?? ""),
        status: "idle",
      })),
    });
  } catch (e) {
    notify("warning", `${TESTS_FILE} could not be read: ${(e as Error).message}`);
  }
}

/** Exam mode: tests come from the exam package instead of a file. */
export function setVisibleTests(entry: string, tests: Omit<TestItem, "status">[]) {
  setTests({ entry, source: "exam", items: tests.map((t) => ({ ...t, status: "idle" })) });
}

export async function runTests(ids?: string[]) {
  const { tests } = useWorkbench.getState();
  if (!tests.entry || tests.running) return;
  const profile = profileForPath(tests.entry);
  if (!profile?.local) {
    notify("warning", `There is no way to run '${tests.entry}' locally.`);
    return;
  }
  await saveAll();
  const selected = tests.items.filter((t) => !ids || ids.includes(t.id));
  for (const t of selected) updateTest(t.id, { status: "queued", actual: undefined, stderr: undefined, message: undefined, duration_ms: undefined });
  setTests({ running: true });
  let built = false;
  let passed = 0;
  try {
    for (const t of selected) {
      updateTest(t.id, { status: "running" });
      let stdout = "";
      let stderr = "";
      let buildOut = "";
      let inBuild = !built && profile.local.build.length > 0;
      try {
        const { done } = await startRun(
          {
            entry: tests.entry,
            // Compile once, then reuse the binary for the remaining tests.
            build: built ? [] : profile.local.build,
            run: profile.local.run,
            mode: "pipe",
            stdin: t.input,
            timeout_ms: profile.limits.wall_s * 1000,
            output_limit_kb: profile.limits.output_kb,
          },
          (e) => {
            if (e.type === "step") inBuild = e.phase === "build";
            else if (e.type === "stdout") inBuild ? (buildOut += e.data) : (stdout += e.data);
            else if (e.type === "stderr") inBuild ? (buildOut += e.data) : (stderr += e.data);
          },
        );
        const exit = await done;
        if (exit.phase === "build") {
          // A compile error fails every test with the same message.
          for (const rest of selected.slice(selected.indexOf(t))) {
            updateTest(rest.id, { status: "error", message: "Build failed", stderr: buildOut });
          }
          notify("error", "The program did not compile. See the Run panel or Problems for details.");
          return;
        }
        built = true;
        const ok = exit.code === 0 && !exit.timed_out && outputsMatch(stdout, t.expected_output);
        if (ok) passed++;
        updateTest(t.id, {
          status: ok ? "passed" : exit.code === 0 || exit.timed_out ? "failed" : "error",
          actual: stdout,
          stderr,
          duration_ms: exit.duration_ms,
          message: exit.timed_out
            ? `Timed out after ${profile.limits.wall_s}s`
            : exit.truncated
              ? "Output limit exceeded"
              : exit.code !== 0
                ? `Exited with code ${exit.code}`
                : ok
                  ? undefined
                  : "Output does not match",
        });
      } catch (e) {
        updateTest(t.id, { status: "error", message: String((e as Error)?.message ?? e) });
      }
    }
    log("Tests", `${passed}/${selected.length} visible tests passed (local check)`);
  } finally {
    setTests({ running: false });
  }
}

export function openTestDiff(testId: string) {
  openEditorInput({ kind: "testDiff", id: `test:${testId}`, testId, preview: false });
}
