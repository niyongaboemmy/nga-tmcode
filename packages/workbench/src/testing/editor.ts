import { registerCommand } from "../commands/registry";
import { pathOfUri } from "../monaco/documents";
import { codeEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { activeFilePath, useWorkbench } from "../state/store";
import { isTestFile, testDeclarations } from "./frameworks";
import { applyMarkers, failedResults, procAvailable, rerunFailed, runAllSuites, runFileTests, runTestAt, suiteOfFile, useFrameworkTests, wireFrameworkTests } from "./service";

const RUN_TEST = "_tmcode.tests.runTest";
const RUN_FILE = "_tmcode.tests.runFile";
const LANGUAGES = ["python", "javascript", "typescript", "go", "rust", "java", "kotlin", "dart", "php", "ruby", "csharp", "swift"];

let wired = false;

/** CodeLens ▶ Run Test above every test, the Test: commands, and markers for re-opened files. */
export function wireTestEditor() {
  if (wired) return;
  wired = true;
  wireFrameworkTests();
  monaco.editor.registerCommand(RUN_TEST, (_a, path: string, line: number) => void runTestAt(path, line));
  monaco.editor.registerCommand(RUN_FILE, (_a, path: string) => void runFileTests(path));

  const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  let last = useFrameworkTests.getState();
  useFrameworkTests.subscribe((s) => {
    if (s.suites !== last.suites || s.state !== last.state || s.running !== last.running) changed.fire(provider);
    last = s;
  });
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses(model) {
      const path = pathOfUri(model.uri);
      if (!procAvailable() || !path || !isTestFile(path) || !suiteOfFile(path)) return { lenses: [], dispose() {} };
      const decls = testDeclarations(model.getValue(), path);
      if (!decls.length) return { lenses: [], dispose() {} };
      const { state, running } = useFrameworkTests.getState();
      const results = Object.values(state).flatMap((s) => s.results);
      const busy = Object.keys(running).length > 0;
      // Rails `test "adds"` reports as test_adds.
      const statusOf = (name: string) => results.find((r) => (r.name === name || r.name === `test_${name.replace(/\s+/g, "_")}`) && (!r.file || r.file === path))?.status;
      const lenses: monaco.languages.CodeLens[] = [
        { range: new monaco.Range(1, 1, 1, 1), command: { id: RUN_FILE, title: busy ? "$(loading~spin) Running tests…" : "$(run-all) Run File Tests", arguments: [path] } },
        ...decls.map((d) => {
          const st = statusOf(d.name);
          const icon = st === "passed" ? "$(pass) " : st === "failed" || st === "error" ? "$(error) " : "";
          return { range: new monaco.Range(d.line, 1, d.line, 1), command: { id: RUN_TEST, title: `${icon}Run Test`, tooltip: `Run ${d.name}`, arguments: [path, d.line] } };
        }),
      ];
      return { lenses, dispose() {} };
    },
  };
  for (const lang of LANGUAGES) monaco.languages.registerCodeLensProvider(lang, provider);
  // Markers live on models: re-apply when a failing test's file is opened again.
  monaco.editor.onDidCreateModel(() => setTimeout(applyMarkers, 0));

  const hasSuites = () => procAvailable() && useFrameworkTests.getState().suites.length > 0;
  const activeSuite = () => procAvailable() && !!suiteOfFile(activeFilePath());
  registerCommand({ id: "testing.runAll", title: "Run All Framework Tests", category: "Test", enabled: hasSuites, run: () => void runAllSuites() });
  registerCommand({
    id: "testing.runAtCursor",
    title: "Run Test at Cursor",
    category: "Test",
    keybinding: "mod+; c",
    enabled: activeSuite,
    run: () => {
      const path = activeFilePath();
      const ed = codeEditorFor(useWorkbench.getState().activeGroup);
      if (path) void runTestAt(path, ed?.getPosition()?.lineNumber ?? 1);
    },
  });
  registerCommand({ id: "testing.runCurrentFile", title: "Run Tests in Current File", category: "Test", keybinding: "mod+; f", enabled: activeSuite, run: () => void runFileTests(activeFilePath()!) });
  registerCommand({ id: "testing.reRunFailTests", title: "Rerun Failed Tests", category: "Test", keybinding: "mod+; e", enabled: () => procAvailable() && failedResults().length > 0, run: () => void rerunFailed() });
}
