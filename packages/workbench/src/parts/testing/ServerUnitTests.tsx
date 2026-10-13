import { useEffect, useState } from "react";
import { summarize, type TestResult } from "@nga/runtimes/testing";
import { revealResult } from "../../testing/service";
import { failuresFirst, reportProblem, runUnitTestsOnServer, serverUnitAvailable, useServerUnit } from "../../testing/serverUnit";
import { useWorkbench } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";

const ICON: Record<TestResult["status"], { icon: string; cls: string; label: string }> = {
  passed: { icon: "pass-filled", cls: "is-passed", label: "Passed" },
  failed: { icon: "error", cls: "is-failed", label: "Failed" },
  error: { icon: "warning", cls: "is-error", label: "Error" },
  skipped: { icon: "debug-step-over", cls: "is-idle", label: "Skipped" },
};

const ms = (n: number | null | undefined) => (n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

/** Whether Task Mentor can run unit tests for this folder (asked once per folder). */
export function useServerUnitAvailable(): boolean {
  const root = useWorkbench((s) => s.workspace?.root ?? null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    void serverUnitAvailable().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, [root]);
  return ok;
}

/**
 * Unit tests run on Task Mentor: one button, then the results in the Testing view's usual rows,
 * failures first with their message and file:line. `always`: show the button even before the
 * capabilities answer (an exam's unit-test question).
 */
export function ServerUnitTests({ title = "Unit Tests on Task Mentor", note }: { title?: string; note?: string }) {
  const available = useServerUnitAvailable();
  const { status, label, report, compile, error, ranAt } = useServerUnit();
  if (!available && !report && !error) return null;
  const results = failuresFirst(report?.tests ?? []);
  const sum = summarize(results);
  const problem = reportProblem(report);
  const running = status === "running";
  return (
    <div className="tm-fwtests tm-server-unit" aria-label={title} data-testid="server-unit-tests">
      <div className="tm-pane-header">
        <Codicon name="cloud" />
        <span className="tm-pane-title">{title}</span>
        <div className="tm-pane-actions" style={{ display: "flex" }}>
          <ActionButton icon={running ? "loading" : "run-all"} className={running ? "codicon-modifier-spin" : ""} label="Run Unit Tests on Task Mentor" disabled={running || !available} onClick={() => void runUnitTestsOnServer()} />
        </div>
      </div>
      {note && <p className="tm-fwtests-note tm-muted">{note}</p>}
      {!ranAt && !running && (
        <button type="button" className="tm-button tm-button--secondary tm-button--block tm-server-unit-run" disabled={!available} onClick={() => void runUnitTestsOnServer()}>
          Run Unit Tests on Task Mentor
        </button>
      )}
      {running && (
        <div className="tm-serverrun" role="status" aria-live="polite">
          <Codicon name="loading" className="codicon-modifier-spin" />
          <span>Running {label ? label.toLowerCase() : "the tests"} on Task Mentor…</span>
        </div>
      )}
      {error && !running && (
        <div className="tm-fwtests-problem" role="alert">
          <Codicon name="warning" />
          <span>{error}</span>
        </div>
      )}
      {report && !running && (
        <>
          {results.length > 0 && (
            <div className="tm-test-summary" role="status">
              <div className="tm-test-bar" aria-hidden>
                <span className="is-passed" style={{ flex: sum.passed }} />
                <span className="is-failed" style={{ flex: sum.failed + sum.error }} />
                <span style={{ flex: sum.skipped }} />
              </div>
              <span>
                {label && <span className="tm-muted">{label}: </span>}
                <strong>{sum.passed}</strong>/{sum.total} passed
                {sum.skipped > 0 && <span className="tm-muted"> · {sum.skipped} skipped</span>}
                {report.framework && <span className="tm-muted"> · {report.framework}</span>}
              </span>
            </div>
          )}
          {problem && (
            <div className={`tm-fwtests-problem ${report.verdict === "passed" ? "" : "is-limit"}`} role="alert">
              <Codicon name="warning" />
              <span>{problem}</span>
            </div>
          )}
          {compile && <pre className="tm-fwtests-output">{compile.slice(-4000)}</pre>}
          <div role="tree" aria-label="Unit test results">
            {results.map((r) => (
              <ResultRow key={r.id} r={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ResultRow({ r }: { r: TestResult }) {
  const bad = r.status === "failed" || r.status === "error";
  const [open, setOpen] = useState(bad);
  const s = ICON[r.status];
  const where = r.file ? `${r.file}${r.line ? `:${r.line}` : ""}` : null;
  return (
    <div role="treeitem" aria-label={`${r.name} ${s.label}`} aria-expanded={bad ? open : undefined} data-status={r.status}>
      <div className={`tm-list-row tm-test-row ${r.status}`} style={{ paddingLeft: 14 }} onClick={() => (bad ? setOpen(!open) : r.file && revealResult(r))}>
        <Codicon name={s.icon} className={`tm-test-icon ${s.cls}`} title={s.label} />
        <span className="tm-tree-label">{r.group ? `${r.group} › ${r.name}` : r.name}</span>
        {bad && r.message && <span className="tm-test-msg">{r.message.split("\n")[0]}</span>}
        <span className="tm-test-time">{ms(r.durationMs)}</span>
      </div>
      {bad && open && (
        <div className="tm-fwtests-detail" style={{ marginLeft: 30 }}>
          {where && (
            <button type="button" className="tm-link-button" onClick={() => revealResult(r)}>
              {where}
            </button>
          )}
          <pre>{r.details || r.message}</pre>
        </div>
      )}
    </div>
  );
}
