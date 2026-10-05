import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { fuzzyMatch, highlightRuns } from "../util/fuzzy";
import { Codicon } from "./icons";

/**
 * VS Code's `showQuickPick` / `showInputBox` for features that need a one-off
 * choice or a line of text (debug configurations, interpreters, arguments).
 * Same look as the command palette.
 */

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  /** Codicon name. */
  icon?: string;
  /** Group label shown on the right of the first item of a group. */
  group?: string;
  value: T;
}

type Request =
  | { kind: "pick"; items: PickItem<unknown>[]; placeholder?: string; title?: string; resolve: (v: unknown) => void }
  | { kind: "input"; prompt?: string; placeholder?: string; value?: string; title?: string; validate?: (v: string) => string | null; resolve: (v: string | undefined) => void };

export const useQuickPick = create<{ request: Request | null; n: number }>()(() => ({ request: null, n: 0 }));

function open(req: Request) {
  // Only one at a time, like VS Code: a new one cancels the old.
  const old = useQuickPick.getState().request;
  if (old) old.resolve(undefined);
  useQuickPick.setState({ request: req, n: useQuickPick.getState().n + 1 });
}

export function showQuickPick<T>(items: PickItem<T>[], opts: { placeholder?: string; title?: string } = {}): Promise<T | undefined> {
  return new Promise((resolve) => open({ kind: "pick", items: items as PickItem<unknown>[], ...opts, resolve: resolve as (v: unknown) => void }));
}

export function showInputBox(opts: { prompt?: string; placeholder?: string; value?: string; title?: string; validate?: (v: string) => string | null } = {}): Promise<string | undefined> {
  return new Promise((resolve) => open({ kind: "input", ...opts, resolve }));
}

function close(value: unknown) {
  const req = useQuickPick.getState().request;
  useQuickPick.setState({ request: null });
  (req?.resolve as ((v: unknown) => void) | undefined)?.(value);
}

export function QuickPickHost() {
  const req = useQuickPick((s) => s.request);
  const n = useQuickPick((s) => s.n);
  if (!req) return null;
  return <QuickPickWidget key={n} req={req} />;
}

function QuickPickWidget({ req }: { req: Request }) {
  const [value, setValue] = useState(req.kind === "input" ? (req.value ?? "") : "");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const items = useMemo(() => {
    if (req.kind !== "pick") return [];
    // Label matches first (best first), then items that only match on their description.
    const matched = req.items
      .map((it) => ({ it, m: fuzzyMatch(value, it.label) ?? (it.description && fuzzyMatch(value, it.description) ? { score: -1e6, indices: [] as number[] } : null) }))
      .filter((x): x is { it: PickItem<unknown>; m: { score: number; indices: number[] } } => !!x.m);
    return value.trim() ? matched.sort((a, b) => b.m.score - a.m.score) : matched;
  }, [req, value]);
  useEffect(() => setIndex(0), [value]);
  const error = req.kind === "input" && req.validate ? req.validate(value) : null;

  const accept = () => {
    if (req.kind === "input") {
      if (!error) close(value);
    } else if (items[index]) close(items[index].it.value);
  };

  return (
    <div className="tm-quick-input-backdrop" onMouseDown={() => close(undefined)}>
      <div className="tm-quick-input" role="dialog" aria-label={req.title ?? "Quick Pick"} onMouseDown={(e) => e.stopPropagation()}>
        {req.title && <div className="tm-qp-title">{req.title}</div>}
        <div className="tm-qi-input-row">
          <input
            ref={inputRef}
            className={`tm-input ${error ? "is-invalid" : ""}`}
            value={value}
            placeholder={req.placeholder}
            aria-label={req.kind === "input" ? (req.prompt ?? req.placeholder ?? "Input") : (req.placeholder ?? "Select an option")}
            role={req.kind === "pick" ? "combobox" : undefined}
            aria-expanded={req.kind === "pick" ? true : undefined}
            aria-controls={req.kind === "pick" ? "tm-qp-list" : undefined}
            aria-activedescendant={req.kind === "pick" && items[index] ? `qp-${index}` : undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              const n = items.length;
              if (e.key === "ArrowDown" && n) setIndex((i) => (i + 1) % n);
              else if (e.key === "ArrowUp" && n) setIndex((i) => (i - 1 + n) % n);
              else if (e.key === "Enter") accept();
              else if (e.key === "Escape") close(undefined);
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
        {req.kind === "input" ? (
          <div className={`tm-qi-message ${error ? "tm-qp-error" : ""}`}>{error ?? `${req.prompt ? `${req.prompt} ` : ""}(Press 'Enter' to confirm or 'Escape' to cancel)`}</div>
        ) : (
          <div id="tm-qp-list" className="tm-qi-list tm-scroll" role="listbox">
            {items.length === 0 && <div className="tm-qi-message">No matching results</div>}
            {items.map(({ it, m }, i) => (
              <div
                key={`${it.label}-${i}`}
                id={`qp-${i}`}
                role="option"
                aria-selected={i === index}
                className={`tm-qi-item ${it.detail ? "has-detail" : ""} ${i === index ? "is-focused" : ""} ${it.group && i > 0 ? "has-separator" : ""}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => close(it.value)}
              >
                {it.icon ? <Codicon name={it.icon} /> : null}
                <span className="tm-qp-text">
                  <span className="tm-qp-line">
                    <span className="tm-qi-label">
                      {highlightRuns(it.label, m.indices).map((r, k) => (r.hit ? <span key={k} className="tm-qi-hit">{r.text}</span> : <span key={k}>{r.text}</span>))}
                    </span>
                    {it.description && <span className="tm-qi-desc">{it.description}</span>}
                  </span>
                  {it.detail && <span className="tm-qp-detail">{it.detail}</span>}
                </span>
                <span className="tm-qi-right">{it.group && <span className="tm-qi-group">{it.group}</span>}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
