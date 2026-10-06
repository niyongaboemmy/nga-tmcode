import { useEffect, useRef, useState } from "react";
import { Codicon } from "../widgets/icons";
import { valueClass } from "./RunDebugView";
import { evaluateInConsole, loadChildren, useDebug, type ConsoleEntry } from "./debugService";
import type { Variable } from "./dap";

const history: string[] = [];

function Expandable({ entry }: { entry: ConsoleEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tm-dc-entry is-${entry.kind}`}>
      <div className="tm-dc-line tm-dc-expandable" role="treeitem" aria-expanded={open} onClick={() => (setOpen(!open), !open && void loadChildren(entry.ref!))}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className={entry.kind === "result" ? valueClass(entry.text, entry.type) : ""}>{entry.text}</span>
      </div>
      {open && <ConsoleChildren ref_={entry.ref!} depth={1} />}
    </div>
  );
}

function ConsoleChildren({ ref_, depth }: { ref_: number; depth: number }) {
  const children = useDebug((s) => s.children[ref_]);
  if (!Array.isArray(children)) return <div className="tm-dc-line tm-muted" style={{ paddingLeft: depth * 14 }}>{children && children !== "loading" ? children.error : "…"}</div>;
  return (
    <>
      {children.map((v, i) => (
        <ConsoleVar key={`${v.name}-${i}`} v={v} depth={depth} />
      ))}
    </>
  );
}

function ConsoleVar({ v, depth }: { v: Variable; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="tm-dc-line" style={{ paddingLeft: depth * 14 }} onClick={() => v.variablesReference && (setOpen(!open), !open && void loadChildren(v.variablesReference))}>
        {v.variablesReference ? <Codicon name={open ? "chevron-down" : "chevron-right"} /> : <span className="tm-dc-indent" />}
        <span className="tm-dv-name">{v.name}</span> <span className={valueClass(v.value, v.type)}>{v.value}</span>
      </div>
      {open && v.variablesReference > 0 && <ConsoleChildren ref_={v.variablesReference} depth={depth + 1} />}
    </>
  );
}

/** The DEBUG CONSOLE panel: adapter output coloured by category, and a REPL evaluated in the focused frame. */
export function DebugConsole({ visible, filter }: { visible: boolean; filter: string }) {
  const entries = useDebug((s) => s.console);
  const phase = useDebug((s) => s.phase);
  const [value, setValue] = useState("");
  const [pos, setPos] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shown = filter ? entries.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase())) : entries;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, visible]);
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="tm-debug-console" data-testid="debug-console">
      <div ref={listRef} className="tm-dc-list tm-scroll tm-mono" role="log" aria-live="polite" aria-label="Debug Console">
        {shown.map((e) =>
          e.ref ? (
            <Expandable key={e.id} entry={e} />
          ) : (
            <div key={e.id} className={`tm-dc-entry is-${e.kind} ${e.category ? `cat-${e.category}` : ""}`}>
              {e.kind === "input" && <Codicon name="chevron-right" className="tm-dc-prompt" />}
              {e.kind === "result" && <Codicon name="arrow-small-left" className="tm-dc-prompt" />}
              <span className={e.kind === "result" ? valueClass(e.text, e.type) : undefined}>{e.text}</span>
            </div>
          ),
        )}
      </div>
      <div className="tm-dc-input-row">
        <Codicon name="chevron-right" className="tm-dc-prompt" />
        <textarea
          ref={inputRef}
          rows={1}
          className="tm-dc-input tm-mono"
          aria-label="Debug Console input"
          placeholder={phase === "stopped" ? "Evaluate an expression in the selected frame" : phase === "inactive" ? "Start debugging (F5) to evaluate expressions" : "Pause the program to evaluate expressions"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const expr = value;
              if (!expr.trim()) return;
              if (history[history.length - 1] !== expr) history.push(expr);
              setPos(-1);
              setValue("");
              void evaluateInConsole(expr);
            } else if (e.key === "ArrowUp" && !value.includes("\n")) {
              e.preventDefault();
              const next = pos < 0 ? history.length - 1 : Math.max(0, pos - 1);
              if (history[next] !== undefined) {
                setPos(next);
                setValue(history[next]);
              }
            } else if (e.key === "ArrowDown" && !value.includes("\n")) {
              e.preventDefault();
              if (pos < 0) return;
              const next = pos + 1;
              setPos(next >= history.length ? -1 : next);
              setValue(next >= history.length ? "" : history[next]);
            }
          }}
        />
      </div>
    </div>
  );
}
