import { useEffect, useMemo, useRef, useState } from "react";
import { revealInEditor } from "../../monaco/reveal";
import { clearOutput, showPanel, togglePanel, togglePanelMaximized, useWorkbench, type PanelId } from "../../state/store";
import { basename, dirname } from "../../util/paths";
import { ActionButton, Codicon, FileIcon } from "../../widgets/icons";
import { TerminalView } from "./TerminalView";
import { RunConsole } from "./RunConsole";
import { executeCommand } from "../../commands/registry";
import { clearConsole } from "../../run/runService";
// ── Run and Debug ──
import { DebugConsole } from "../../debug/DebugConsole";
import { clearDebugConsole, debugAllowed } from "../../debug/debugService";
import { useExam } from "../../exam/state";
// ── end Run and Debug ──
// ── Run hub: JavaScript Console, run state badges ──
import { JsConsoleView } from "./JsConsoleView";
import { clearJsConsole, rerunJsConsole, stopJsConsole, useJsConsole } from "../../run/jsConsole";
import { RunStateBadge } from "./RunStateBadge";
// ── end Run hub ──
import { OutputChannelPicker, useOutputChannelFilter } from "../../exthost/ui";

function ProblemsView({ filter }: { filter: string }) {
  const problems = useWorkbench((s) => s.problems);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const byFile = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, typeof problems>();
    for (const p of problems) {
      if (q && !`${p.message} ${p.path} ${p.source ?? ""}`.toLowerCase().includes(q)) continue;
      map.set(p.path, [...(map.get(p.path) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "error" ? -1 : 1));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [problems, filter]);

  if (!byFile.length) {
    return <div className="tm-panel-empty">{problems.length ? "No results found with provided filter criteria." : "No problems have been detected in the workspace."}</div>;
  }

  const reveal = (path: string, line: number, column: number) => revealInEditor(path, line, column);

  return (
    <div className="tm-problems tm-scroll" role="tree" aria-label="Problems">
      {byFile.map(([path, list]) => {
        const open = !collapsed[path];
        return (
          <div key={path} role="treeitem" aria-expanded={open}>
            <div
              className="tm-list-row tm-problems-file"
              onClick={() => {
                const next = { ...collapsed };
                if (open) next[path] = true;
                else delete next[path];
                setCollapsed(next);
              }}
            >
              <span className="tm-twistie">
                <Codicon name={open ? "chevron-down" : "chevron-right"} />
              </span>
              <FileIcon path={path} />
              <span className="tm-tree-label">{basename(path)}</span>
              <span className="tm-search-dir">{dirname(path)}</span>
              <span className="tm-badge">{list.length}</span>
            </div>
            {open &&
              list.map((p, i) => (
                <div key={i} className="tm-list-row tm-problem" onClick={() => reveal(p.path, p.line, p.column)} title={p.message}>
                  <Codicon name={p.severity === "error" ? "error" : p.severity === "warning" ? "warning" : "info"} className={`tm-sev-${p.severity}`} />
                  <span className="tm-problem-msg">{p.message}</span>
                  {p.source && <span className="tm-muted">{p.source}</span>}
                  <span className="tm-muted">
                    [Ln {p.line}, Col {p.column}]
                  </span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function OutputView({ filter }: { filter: string }) {
  const all = useWorkbench((s) => s.output);
  const channel = useOutputChannelFilter();
  const output = channel ? all.filter((l) => l.channel === channel) : all;
  const ref = useRef<HTMLDivElement>(null);
  const lines = filter ? output.filter((l) => `${l.channel} ${l.text}`.toLowerCase().includes(filter.toLowerCase())) : output;
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div ref={ref} className="tm-output tm-scroll tm-mono" role="log" aria-live="polite">
      {lines.map((l, i) => (
        <div key={i} className={`tm-output-line is-${l.level}`}>
          <span className="tm-output-time">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
          <span className="tm-output-channel">[{l.channel}]</span> {l.text}
        </div>
      ))}
    </div>
  );
}

export function Panel() {
  const active = useWorkbench((s) => s.activePanel);
  const maximized = useWorkbench((s) => s.panelMaximized);
  const problemCount = useWorkbench((s) => s.problems.filter((p) => p.severity !== "info").length);
  const terminalAllowed = useWorkbench((s) => s.policy.terminal !== "off");
  const panelVisible = useWorkbench((s) => s.panelVisible);
  const run = useWorkbench((s) => s.run);
  const js = { status: useJsConsole((s) => s.status), file: useJsConsole((s) => s.file), last: useJsConsole((s) => s.last), startedAt: useJsConsole((s) => s.startedAt) };
  const [filter, setFilter] = useState("");
  useExam((s) => s.phase);
  useWorkbench((s) => s.policy);
  const debugTab = debugAllowed();

  const tabs: { id: PanelId; label: string; badge?: number }[] = [
    { id: "problems", label: "Problems", badge: problemCount || undefined },
    { id: "output", label: "Output" },
    ...(debugTab ? [{ id: "debugConsole" as const, label: "Debug Console" }] : []),
    { id: "run", label: "Run" },
    { id: "jsConsole", label: "JavaScript Console" },
    ...(terminalAllowed ? [{ id: "terminal" as const, label: "Terminal" }] : []),
  ];
  const current = tabs.some((t) => t.id === active) ? active : "problems";

  return (
    <section className="tm-panel" aria-label="Panel">
      <header className="tm-panel-header">
        <div className="tm-panel-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={current === t.id}
              className={`tm-panel-tab ${current === t.id ? "is-active" : ""}`}
              onClick={() => showPanel(t.id)}
            >
              {t.label}
              {t.badge ? <span className="tm-badge tm-badge--accent">{t.badge}</span> : null}
            </button>
          ))}
        </div>
        <div className="tm-panel-actions">
          {current === "run" && (
            <>
              {run.label && <span className="tm-panel-run-label">{run.label}</span>}
              <RunStateBadge
                running={run.status !== "idle"}
                phase={run.status === "building" ? "Building" : "Running"}
                since={run.startedAt ?? null}
                exit={
                  run.lastExit
                    ? {
                        ok: run.lastExit.code === 0 && !run.lastExit.timed_out && !run.lastExit.killed,
                        label: run.lastExit.killed ? "stopped" : run.lastExit.timed_out ? "timed out" : `exit ${run.lastExit.code ?? "?"}`,
                        ms: run.lastExit.duration_ms,
                      }
                    : null
                }
              />
              {run.status !== "idle" ? (
                <ActionButton icon="debug-stop" label="Stop (Shift+F5)" className="tm-stop" onClick={() => executeCommand("tmcode.stop")} />
              ) : (
                run.entry && <ActionButton icon="debug-restart" label="Run Again" onClick={() => executeCommand("tmcode.rerun")} />
              )}
              <ActionButton icon="clear-all" label="Clear" onClick={clearConsole} />
            </>
          )}
          {current === "jsConsole" && (
            <>
              {js.file && <span className="tm-panel-run-label">{js.file}</span>}
              <RunStateBadge
                running={js.status === "running"}
                phase="Running"
                since={js.startedAt}
                exit={js.last && js.file ? { ok: js.last.ok, label: js.last.stopped ? "stopped" : js.last.ok ? "done" : "error", ms: js.last.ms } : null}
              />
              {js.status === "running" ? (
                <ActionButton icon="debug-stop" label="Stop (Shift+F5)" className="tm-stop" onClick={stopJsConsole} />
              ) : (
                js.file && <ActionButton icon="debug-restart" label="Run Again" onClick={rerunJsConsole} />
              )}
            </>
          )}
          {current !== "terminal" && current !== "run" && (
            <div className="tm-input-box tm-panel-filter">
              <input className="tm-input" placeholder={current === "problems" ? "Filter (e.g. text, **/*.py)" : "Filter"} aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <Codicon name="filter" className="tm-input-trailing" />
            </div>
          )}
          {current === "output" && <OutputChannelPicker />}
          {current === "output" && <ActionButton icon="clear-all" label="Clear Output" onClick={clearOutput} />}
          {current === "debugConsole" && <ActionButton icon="clear-all" label="Clear Console" onClick={clearDebugConsole} />}
          {current === "jsConsole" && <ActionButton icon="clear-all" label="Clear Console" onClick={clearJsConsole} />}
          {current === "terminal" && (
            <ActionButton icon="add" label="New Terminal" onClick={() => window.dispatchEvent(new CustomEvent("tmcode:new-terminal"))} />
          )}
          <ActionButton icon={maximized ? "chevron-down" : "chevron-up"} label={maximized ? "Restore Panel Size" : "Maximize Panel Size"} onClick={togglePanelMaximized} />
          <ActionButton icon="close" label="Hide Panel" onClick={() => togglePanel(false)} />
        </div>
      </header>
      <div className="tm-panel-body">
        {current === "problems" && <ProblemsView filter={filter} />}
        {current === "output" && <OutputView filter={filter} />}
        {debugTab && <DebugConsole visible={panelVisible && current === "debugConsole"} filter={filter} />}
        <RunConsole visible={panelVisible && current === "run"} />
        <JsConsoleView visible={panelVisible && current === "jsConsole"} filter={filter} />
        {terminalAllowed && <TerminalView visible={panelVisible && current === "terminal"} />}
      </div>
    </section>
  );
}
