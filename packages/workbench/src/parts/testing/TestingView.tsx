import { executeCommand } from "../../commands/registry";
import { getPlatform, openFile, useWorkbench, type TestItem } from "../../state/store";
import { TESTS_FILE, openTestDiff, runTests } from "../../run/testService";
import { useFrameworkTests } from "../../testing/service";
import { ActionButton, Codicon } from "../../widgets/icons";
import { FrameworkTests } from "./FrameworkTests";

const STATUS_ICON: Record<TestItem["status"], { icon: string; cls: string; label: string }> = {
  idle: { icon: "circle-large-outline", cls: "is-idle", label: "Not run" },
  queued: { icon: "history", cls: "is-idle", label: "Queued" },
  running: { icon: "loading", cls: "is-running codicon-modifier-spin", label: "Running" },
  passed: { icon: "pass-filled", cls: "is-passed", label: "Passed" },
  failed: { icon: "error", cls: "is-failed", label: "Failed" },
  error: { icon: "warning", cls: "is-error", label: "Error" },
};

const SAMPLE = `{
  "entry": "main.py",
  "tests": [
    { "id": "t1", "name": "example", "input": "2\\n80\\n90\\n", "expected_output": "85.0 A\\n" }
  ]
}
`;

export function TestingView() {
  const tests = useWorkbench((s) => s.tests);
  const workspace = useWorkbench((s) => s.workspace);
  const hasSuites = useFrameworkTests((s) => s.suites.length > 0);
  const canRun = !!getPlatform().runner;
  const passed = tests.items.filter((t) => t.status === "passed").length;
  const failed = tests.items.filter((t) => t.status === "failed" || t.status === "error").length;
  const done = tests.items.filter((t) => ["passed", "failed", "error"].includes(t.status)).length;

  if (!workspace) return <div className="tm-view-empty">Open a folder or start a task from Task Mentor to see its tests.</div>;

  if (!tests.items.length && hasSuites) {
    return (
      <div className="tm-pane tm-testing">
        <div className="tm-pane-body tm-scroll">
          <FrameworkTests />
        </div>
      </div>
    );
  }

  if (!tests.items.length) {
    return (
      <div className="tm-view-empty">
        <p>No tests yet.</p>
        <p className="tm-muted">
          When you take a coding task from Task Mentor, its sample tests appear here so you can check your program before you submit.
        </p>
        <p className="tm-muted">
          To practise with your own tests, describe them in <code>{TESTS_FILE}</code>.
        </p>
        <p className="tm-muted">
          Project tests (pytest, JUnit, Vitest, Jest, go test, cargo test, PHPUnit, RSpec, dotnet test…) appear here when the folder has them.
        </p>
        <button
          type="button"
          className="tm-button tm-button--secondary tm-button--block"
          onClick={async () => {
            const fs = getPlatform().fs;
            await fs.createDir(".tmcode").catch(() => {});
            await fs.writeFile(TESTS_FILE, SAMPLE);
            openFile(TESTS_FILE, { pinned: true });
          }}
        >
          Create {TESTS_FILE}
        </button>
      </div>
    );
  }

  return (
    <div className="tm-pane tm-testing">
      {hasSuites && (
        <div className="tm-fwtests-wrap tm-scroll">
          <FrameworkTests />
        </div>
      )}
      <div className="tm-pane-header" aria-label="Tests">
        <Codicon name="chevron-down" />
        <span className="tm-pane-title">{tests.entry}</span>
        <div className="tm-pane-actions" style={{ display: "flex" }}>
          <ActionButton
            icon="run-all"
            label="Run All Tests"
            disabled={tests.running || !canRun}
            onClick={() => void runTests()}
          />
          <ActionButton icon="refresh" label="Reload Tests" onClick={() => executeCommand("tmcode.reloadTests")} />
        </div>
      </div>
      {done > 0 && (
        <div className="tm-test-summary" role="status">
          <div className="tm-test-bar" aria-hidden>
            <span className="is-passed" style={{ flex: passed }} />
            <span className="is-failed" style={{ flex: failed }} />
            <span style={{ flex: tests.items.length - done }} />
          </div>
          <span>
            <strong>{passed}</strong>/{tests.items.length} passed
          </span>
          {tests.running && <span className="tm-muted">running…</span>}
        </div>
      )}
      <div className="tm-pane-body tm-scroll" role="tree" aria-label="Tests">
        {tests.items.map((t) => {
          const s = STATUS_ICON[t.status];
          return (
            <div
              key={t.id}
              role="treeitem"
              className={`tm-list-row tm-test-row ${t.status}`}
              title={t.message ? `${t.name}: ${t.message}` : t.name}
              onClick={() => ["passed", "failed", "error"].includes(t.status) && openTestDiff(t.id)}
            >
              <Codicon name={s.icon} className={`tm-test-icon ${s.cls}`} title={s.label} />
              <span className="tm-tree-label">{t.name}</span>
              {t.message && t.status !== "passed" && <span className="tm-test-msg">{t.message}</span>}
              {t.duration_ms !== undefined && <span className="tm-test-time">{t.duration_ms} ms</span>}
              <ActionButton
                icon="play"
                label={`Run ${t.name}`}
                className="tm-test-run"
                disabled={tests.running || !canRun}
                onClick={(e) => {
                  e.stopPropagation();
                  void runTests([t.id]);
                }}
              />
            </div>
          );
        })}
      </div>
      <p className="tm-test-note">
        <Codicon name="info" /> These are sample tests checked on your computer. Your grade comes from Task Mentor, which also runs hidden tests.
      </p>
    </div>
  );
}
