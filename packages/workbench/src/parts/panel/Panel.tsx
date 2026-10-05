import { useEffect, useMemo, useRef, useState } from "react";
import { codeEditorFor } from "../../monaco/editors";
import { clearOutput, openFile, showPanel, togglePanel, togglePanelMaximized, useWorkbench, workbench, type PanelId } from "../../state/store";
import { basename, dirname } from "../../util/paths";
import { ActionButton, Codicon, FileIcon } from "../../widgets/icons";
import { TerminalView } from "./TerminalView";

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

  const reveal = (path: string, line: number, column: number) => {
    openFile(path, { pinned: true });
    const go = (n = 0) => {
      const ed = codeEditorFor(workbench.get().activeGroup);
      if (ed?.getModel()?.uri.path === `/${path}`) {
        ed.setPosition({ lineNumber: line, column });
        ed.revealLineInCenterIfOutsideViewport(line);
        ed.focus();
      } else if (n < 20) setTimeout(() => go(n + 1), 25);
    };
    go();
  };

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
  const output = useWorkbench((s) => s.output);
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
  const [filter, setFilter] = useState("");

  const tabs: { id: PanelId; label: string; badge?: number }[] = [
    { id: "problems", label: "Problems", badge: problemCount || undefined },
    { id: "output", label: "Output" },
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
          {current !== "terminal" && (
            <div className="tm-input-box tm-panel-filter">
              <input className="tm-input" placeholder={current === "problems" ? "Filter (e.g. text, **/*.py)" : "Filter"} aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <Codicon name="filter" className="tm-input-trailing" />
            </div>
          )}
          {current === "output" && <ActionButton icon="clear-all" label="Clear Output" onClick={clearOutput} />}
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
        {terminalAllowed && <TerminalView visible={panelVisible && current === "terminal"} />}
      </div>
    </section>
  );
}
