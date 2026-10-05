import { useEffect, useRef, useState } from "react";
import { normalizeOutput } from "@tmcode/protocol";
import { monaco, setupMonaco } from "../../monaco/setup";
import { runTests } from "../../run/testService";
import { getPlatform, useWorkbench, type EditorInput } from "../../state/store";
import { defaultFontFamily } from "../../state/settings";
import { Codicon } from "../../widgets/icons";

type DiffInput = Extract<EditorInput, { kind: "testDiff" }>;

/** Expected (left) vs actual (right) output of one test, like VS Code's test peek. */
export function TestDiffEditor({ input }: { input: DiffInput }) {
  const test = useWorkbench((s) => s.tests.items.find((t) => t.id === input.testId));
  const running = useWorkbench((s) => s.tests.running);
  const fontSize = useWorkbench((s) => s.settings["editor.fontSize"]);
  const host = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [showInput, setShowInput] = useState(true);

  useEffect(() => {
    setupMonaco();
    const diff = monaco.editor.createDiffEditor(host.current!, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      renderWhitespace: "all",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: defaultFontFamily(getPlatform().os),
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
    });
    // One pair of models for the editor's lifetime; re-runs only change their text
    // (replacing models mid-diff makes Monaco throw "no diff result available").
    const original = monaco.editor.createModel("", "plaintext");
    const modified = monaco.editor.createModel("", "plaintext");
    diff.setModel({ original, modified });
    diffRef.current = diff;
    return () => {
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, []);

  const expected = test?.expected_output;
  const actual = test?.actual;
  useEffect(() => {
    const m = diffRef.current?.getModel();
    if (!m) return;
    const e = normalizeOutput(expected);
    const a = normalizeOutput(actual ?? "");
    if (m.original.getValue() !== e) m.original.setValue(e);
    if (m.modified.getValue() !== a) m.modified.setValue(a);
  }, [expected, actual]);

  useEffect(() => {
    diffRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  if (!test) return <div className="tm-panel-empty">This test no longer exists.</div>;
  const ok = test.status === "passed";

  return (
    <div className="tm-testdiff">
      <div className={`tm-testdiff-head ${ok ? "is-passed" : "is-failed"}`}>
        <Codicon name={ok ? "pass-filled" : "error"} />
        <strong>{test.name}</strong>
        <span>{ok ? "Passed" : test.message ?? "Failed"}</span>
        {test.duration_ms !== undefined && <span className="tm-muted">{test.duration_ms} ms</span>}
        <button type="button" className="tm-button tm-button--secondary tm-testdiff-rerun" disabled={running} onClick={() => void runTests([test.id])}>
          <Codicon name="play" /> Run again
        </button>
      </div>
      <div className="tm-testdiff-io">
        <button type="button" className="tm-link-button" onClick={() => setShowInput(!showInput)} aria-expanded={showInput}>
          <Codicon name={showInput ? "chevron-down" : "chevron-right"} /> Input
        </button>
        {showInput && <pre className="tm-testdiff-input tm-mono">{test.input || "(no input)"}</pre>}
        {test.stderr ? <pre className="tm-testdiff-stderr tm-mono">{test.stderr}</pre> : null}
      </div>
      <div className="tm-testdiff-labels">
        <span>Expected output</span>
        <span>Your output</span>
      </div>
      <div ref={host} className="tm-testdiff-editor" />
    </div>
  );
}
