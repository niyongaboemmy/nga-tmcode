import { useMemo, useState } from "react";
import { showPanel } from "../../state/store";
import { summarize, type TestResult } from "../../testing/parsers";
import { procAvailable, rerunFailed, revealResult, runAllSuites, runSuite, stopSuite, useFrameworkTests, type SuiteState } from "../../testing/service";
import type { TestSuite } from "../../testing/frameworks";
import { ActionButton, Codicon } from "../../widgets/icons";

const ICON: Record<TestResult["status"], { icon: string; cls: string; label: string }> = {
  passed: { icon: "pass-filled", cls: "is-passed", label: "Passed" },
  failed: { icon: "error", cls: "is-failed", label: "Failed" },
  error: { icon: "warning", cls: "is-error", label: "Error" },
  skipped: { icon: "debug-step-over", cls: "is-idle", label: "Skipped" },
};

const ms = (n: number | null) => (n === null ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

/** Groups' worst status first: failures float up like VS Code's "sort by status". */
const rank = (s: TestResult["status"]) => (s === "failed" || s === "error" ? 0 : s === "skipped" ? 2 : 1);

/** Pytest, JUnit, Vitest… results found by running the project's own test command. */
export function FrameworkTests() {
  const { suites, state, running } = useFrameworkTests();
  const [filter, setFilter] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const canRun = procAvailable();
  const all = Object.values(state).flatMap((s) => s.results);
  const sum = summarize(all);
  const busy = Object.keys(running).length > 0;

  return (
    <div className="tm-fwtests" aria-label="Framework tests">
      <div className="tm-pane-header">
        <Codicon name="chevron-down" />
        <span className="tm-pane-title">Project Tests</span>
        <div className="tm-pane-actions" style={{ display: "flex" }}>
          <ActionButton icon="run-all" label="Run All Project Tests" disabled={!canRun || busy} onClick={() => void runAllSuites()} />
          <ActionButton icon="debug-rerun" label="Rerun Failed Tests" disabled={!canRun || busy || sum.failed + sum.error === 0} onClick={() => void rerunFailed()} />
          <ActionButton icon="output" label="Show Test Output" onClick={() => showPanel("output")} />
        </div>
      </div>
      {!canRun && <p className="tm-fwtests-note tm-muted">Project tests run in the TMCode desktop app, outside exams.</p>}
      {all.length > 0 && (
        <div className="tm-test-summary" role="status">
          <div className="tm-test-bar" aria-hidden>
            <span className="is-passed" style={{ flex: sum.passed }} />
            <span className="is-failed" style={{ flex: sum.failed + sum.error }} />
            <span style={{ flex: sum.skipped }} />
          </div>
          <span>
            <strong>{sum.passed}</strong>/{sum.total} passed
            {sum.skipped > 0 && <span className="tm-muted"> · {sum.skipped} skipped</span>}
          </span>
        </div>
      )}
      {all.length > 0 && (
        <div className="tm-fwtests-filter">
          <input className="tm-input" type="search" placeholder="Filter tests" aria-label="Filter tests" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ActionButton icon="filter" label={onlyFailed ? "Show All Tests" : "Show Only Failed Tests"} active={onlyFailed} onClick={() => setOnlyFailed(!onlyFailed)} />
        </div>
      )}
      <div role="tree" aria-label="Project tests">
        {suites.map((s) => (
          <SuiteNode key={s.id} suite={s} st={state[s.id]} run={running[s.id]?.scope ?? null} canRun={canRun} filter={filter.trim().toLowerCase()} onlyFailed={onlyFailed} />
        ))}
      </div>
    </div>
  );
}

function SuiteNode({ suite, st, run, canRun, filter, onlyFailed }: { suite: TestSuite; st?: SuiteState; run: string | null; canRun: boolean; filter: string; onlyFailed: boolean }) {
  const [open, setOpen] = useState(true);
  const results = useMemo(
    () => (st?.results ?? []).filter((r) => (!onlyFailed || r.status === "failed" || r.status === "error") && (!filter || `${r.group} ${r.name}`.toLowerCase().includes(filter))),
    [st, filter, onlyFailed],
  );
  const groups = useMemo(() => {
    const m = new Map<string, TestResult[]>();
    for (const r of results) m.set(r.group || suite.label, [...(m.get(r.group || suite.label) ?? []), r]);
    return [...m].sort((a, b) => Math.min(...a[1].map((r) => rank(r.status))) - Math.min(...b[1].map((r) => rank(r.status))) || a[0].localeCompare(b[0]));
  }, [results, suite.label]);
  const sum = summarize(st?.results ?? []);
  const failed = sum.failed + sum.error;
  const icon = run ? { icon: "loading", cls: "is-running codicon-modifier-spin", label: "Running" } : !st ? { icon: "circle-large-outline", cls: "is-idle", label: "Not run" } : st.problem ? ICON.error : failed ? ICON.failed : ICON.passed;

  return (
    <div role="treeitem" aria-expanded={open} aria-label={suite.label} className="tm-fwtests-suite" data-suite={suite.id}>
      <div className="tm-list-row tm-test-row tm-fwtests-suite-row" onClick={() => setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <Codicon name={icon.icon} className={`tm-test-icon ${icon.cls}`} title={icon.label} />
        <span className="tm-tree-label">{suite.label}</span>
        {run ? (
          <span className="tm-test-msg">running {run === "all" ? "all tests" : run}…</span>
        ) : (
          st && !st.problem && <span className="tm-test-msg">{failed ? `${failed} failed · ` : ""}{sum.passed}/{sum.total} passed</span>
        )}
        {run ? (
          <ActionButton icon="debug-stop" label={`Stop ${suite.label}`} className="tm-fwtests-act" onClick={(e) => (e.stopPropagation(), stopSuite(suite.id))} />
        ) : (
          <ActionButton icon="play" label={`Run ${suite.label}`} className="tm-test-run tm-fwtests-act" disabled={!canRun} onClick={(e) => (e.stopPropagation(), void runSuite(suite.id))} />
        )}
      </div>
      {open && (
        <div role="group">
          {!st && !run && (
            <div className="tm-fwtests-hint tm-muted">
              <code>{suite.command()}</code>
            </div>
          )}
          {st?.problem && (
            <div className="tm-fwtests-problem" role="alert">
              <Codicon name="warning" />
              <span>{st.problem}</span>
              <button type="button" className="tm-link-button" onClick={() => showPanel("output")}>
                Show output
              </button>
            </div>
          )}
          {groups.map(([group, rs]) => (
            <GroupNode key={group} suite={suite} group={group} results={rs} canRun={canRun && !run} single={groups.length === 1 && group === suite.label} />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupNode({ suite, group, results, canRun, single }: { suite: TestSuite; group: string; results: TestResult[]; canRun: boolean; single: boolean }) {
  const [open, setOpen] = useState(true);
  const failed = results.filter((r) => r.status === "failed" || r.status === "error").length;
  const file = results.find((r) => r.file)?.file ?? null;
  const sorted = [...results].sort((a, b) => rank(a.status) - rank(b.status) || (a.line ?? 0) - (b.line ?? 0));
  const rows = sorted.map((r) => <ResultNode key={r.id} suite={suite} r={r} canRun={canRun} indent={single ? 1 : 2} />);
  if (single) return <>{rows}</>;
  return (
    <div role="treeitem" aria-expanded={open} aria-label={group}>
      <div className="tm-list-row tm-test-row tm-fwtests-group" style={{ paddingLeft: 30 }} onClick={() => setOpen(!open)} title={group}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <Codicon name={failed ? ICON.failed.icon : ICON.passed.icon} className={`tm-test-icon ${failed ? "is-failed" : "is-passed"}`} />
        <span className="tm-tree-label">{group}</span>
        <span className="tm-test-time">{failed ? `${failed}/${results.length}` : results.length}</span>
        {file && (
          <ActionButton
            icon="run-all"
            label={`Run tests in ${file}`}
            className="tm-test-run"
            disabled={!canRun}
            onClick={(e) => {
              e.stopPropagation();
              void runSuite(suite.id, { file });
            }}
          />
        )}
      </div>
      {open && <div role="group">{rows}</div>}
    </div>
  );
}

function ResultNode({ suite, r, canRun, indent }: { suite: TestSuite; r: TestResult; canRun: boolean; indent: number }) {
  const [open, setOpen] = useState(false);
  const s = ICON[r.status];
  const bad = r.status === "failed" || r.status === "error";
  return (
    <div role="treeitem" aria-label={`${r.name} ${s.label}`} aria-expanded={bad ? open : undefined} data-status={r.status}>
      <div
        className={`tm-list-row tm-test-row ${r.status}`}
        style={{ paddingLeft: 14 + indent * 16 }}
        onClick={() => {
          if (bad) setOpen(!open);
          revealResult(r);
        }}
      >
        <Codicon name={s.icon} className={`tm-test-icon ${s.cls}`} title={s.label} />
        <span className="tm-tree-label">{r.name}</span>
        {bad && r.message && <span className="tm-test-msg">{r.message.split("\n")[0]}</span>}
        <span className="tm-test-time">{ms(r.durationMs)}</span>
        <ActionButton
          icon="play"
          label={`Run ${r.name}`}
          className="tm-test-run"
          disabled={!canRun}
          onClick={(e) => {
            e.stopPropagation();
            void runSuite(suite.id, { file: r.file ?? undefined, test: { name: r.name, group: r.group } });
          }}
        />
      </div>
      {bad && open && (
        <div className="tm-fwtests-detail" style={{ marginLeft: 30 + indent * 16 }}>
          {r.file && (
            <button type="button" className="tm-link-button" onClick={() => revealResult(r)}>
              {r.file}
              {r.line ? `:${r.line}` : ""}
            </button>
          )}
          <pre>{r.details || r.message}</pre>
        </div>
      )}
    </div>
  );
}
