import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { closeQuickInput } from "../state/store";
import { fuzzyMatch, highlightRuns } from "../util/fuzzy";
import { Codicon } from "./icons";

/**
 * VS Code's `showQuickPick` / `showInputBox` for features (git branches,
 * clone sources, sign-in…): a promise-based picker in the same widget style
 * as the command palette, with a skeleton while items load.
 */

export interface PickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  /** Codicon name. */
  icon?: string;
  /** Group label shown on the right of the first item of a group, with a separator line. */
  separator?: string;
  /** Shown whatever the filter. */
  alwaysShow?: boolean;
}

export interface QuickPickOptions {
  title?: string;
  placeholder?: string;
  /** A promise shows a skeleton until it settles. */
  items: PickItem[] | Promise<PickItem[]>;
  /** Extra items computed from the typed text (e.g. "Clone from URL <typed>"), shown first. */
  dynamicItems?: (value: string) => PickItem[];
  matchOnDescription?: boolean;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeholder?: string;
  value?: string;
  password?: boolean;
  validate?: (value: string) => string | null;
  /** Small links under the prompt (e.g. "Create a token on GitHub"). */
  links?: { label: string; run: () => void }[];
}

type Request = { id: number } & (
  | { kind: "pick"; options: QuickPickOptions; resolve: (item: PickItem | undefined) => void }
  | { kind: "input"; options: InputBoxOptions; resolve: (value: string | undefined) => void }
);
let seq = 0;

export const useQuickPick = create<{ request: Request | null }>(() => ({ request: null }));

function open(req: Omit<Extract<Request, { kind: "pick" }>, "id"> | Omit<Extract<Request, { kind: "input" }>, "id">) {
  // Only one quick input at a time: a pending one is cancelled.
  const prev = useQuickPick.getState().request;
  if (prev) prev.resolve(undefined);
  closeQuickInput();
  useQuickPick.setState({ request: { ...req, id: ++seq } as Request });
}

function close() {
  useQuickPick.setState({ request: null });
}

export function showQuickPick(options: QuickPickOptions): Promise<PickItem | undefined> {
  return new Promise((resolve) => open({ kind: "pick", options, resolve }));
}

export function showInputBox(options: InputBoxOptions): Promise<string | undefined> {
  return new Promise((resolve) => open({ kind: "input", options, resolve: resolve as (v: string | undefined) => void }));
}

export function QuickPickHost() {
  const req = useQuickPick((s) => s.request);
  if (!req) return null;
  return req.kind === "pick" ? <PickWidget key={req.id} req={req} /> : <InputWidget key={req.id} req={req} />;
}

function Highlighted({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, indices).map((r, i) => (r.hit ? <span key={i} className="tm-qi-hit">{r.text}</span> : <span key={i}>{r.text}</span>))}
    </>
  );
}

function Frame({ title, onCancel, children }: { title?: string; onCancel: () => void; children: React.ReactNode }) {
  return (
    <div className="tm-quick-input-backdrop" onMouseDown={onCancel}>
      <div className="tm-quick-input tm-quick-pick" role="dialog" aria-label={title ?? "Quick Input"} onMouseDown={(e) => e.stopPropagation()}>
        {title && <div className="tm-qp-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

function PickWidget({ req }: { req: Extract<Request, { kind: "pick" }> }) {
  const { options } = req;
  const [value, setValue] = useState("");
  const [items, setItems] = useState<PickItem[] | null>(Array.isArray(options.items) ? options.items : null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (Array.isArray(options.items)) return;
    let live = true;
    options.items.then(
      (list) => live && setItems(list),
      (e) => live && (setItems([]), setError(String((e as Error)?.message ?? e))),
    );
    return () => {
      live = false;
    };
  }, [options.items]);

  const finish = (item: PickItem | undefined) => {
    close();
    req.resolve(item);
  };

  const shown = useMemo(() => {
    const dyn = options.dynamicItems?.(value) ?? [];
    const scored = (items ?? [])
      .map((it) => {
        const m = fuzzyMatch(value, it.label) ?? (options.matchOnDescription && it.description && fuzzyMatch(value, it.description) ? { score: 0, indices: [] } : null);
        return m || it.alwaysShow ? { it, indices: m?.indices ?? [], score: m?.score ?? -1 } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (value.trim()) scored.sort((a, b) => Number(!!b.it.alwaysShow) - Number(!!a.it.alwaysShow) || b.score - a.score);
    // Separators only make sense in the unfiltered order.
    const list = scored.map((s) => ({ ...s, it: value.trim() ? { ...s.it, separator: undefined } : s.it }));
    return [...dyn.map((it) => ({ it, indices: [] as number[], score: 0 })), ...list];
  }, [items, value, options]);

  useEffect(() => setIndex(0), [value]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const loading = items === null;
  return (
    <Frame title={options.title} onCancel={() => finish(undefined)}>
      <div className="tm-qi-input-row">
        <input
          ref={inputRef}
          className="tm-input"
          value={value}
          placeholder={options.placeholder}
          aria-label={options.placeholder ?? options.title ?? "Pick an item"}
          role="combobox"
          aria-expanded
          aria-controls="tm-qp-list"
          aria-activedescendant={shown[index] ? `qp-${index}` : undefined}
          aria-busy={loading}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            const n = shown.length;
            if (e.key === "ArrowDown") setIndex((i) => (n ? (i + 1) % n : 0));
            else if (e.key === "ArrowUp") setIndex((i) => (n ? (i - 1 + n) % n : 0));
            else if (e.key === "PageDown") setIndex((i) => Math.min(n - 1, i + 10));
            else if (e.key === "PageUp") setIndex((i) => Math.max(0, i - 10));
            else if (e.key === "Enter") shown[index] && finish(shown[index].it);
            else if (e.key === "Escape") finish(undefined);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </div>
      {loading && <div className="tm-qp-progress" role="progressbar" aria-label="Loading" />}
      <div ref={listRef} id="tm-qp-list" className="tm-qi-list tm-scroll" role="listbox">
        {loading &&
          shown.length === 0 &&
          [72, 54, 64, 46, 58].map((w, i) => (
            <div key={i} className="tm-qi-item tm-qp-skeleton" aria-hidden>
              <span className="tm-skeleton" style={{ width: 16, height: 14 }} />
              <span className="tm-skeleton" style={{ width: `${w}%`, height: 10 }} />
            </div>
          ))}
        {!loading && shown.length === 0 && <div className="tm-qi-message">{error ?? "No matching results"}</div>}
        {shown.map(({ it, indices }, i) => (
          <div
            key={it.id}
            id={`qp-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === index}
            className={`tm-qi-item ${it.detail ? "has-detail" : ""} ${i === index ? "is-focused" : ""} ${it.separator && i > 0 ? "has-separator" : ""}`}
            onMouseMove={() => i !== index && setIndex(i)}
            onClick={() => finish(it)}
          >
            {it.icon ? <Codicon name={it.icon} /> : null}
            <span className="tm-qp-text">
              <span className="tm-qp-line">
                <span className="tm-qi-label">
                  <Highlighted text={it.label} indices={indices} />
                </span>
                {it.description && <span className="tm-qi-desc">{it.description}</span>}
              </span>
              {it.detail && <span className="tm-qp-detail">{it.detail}</span>}
            </span>
            {it.separator && (
              <span className="tm-qi-right">
                <span className="tm-qi-group">{it.separator}</span>
              </span>
            )}
          </div>
        ))}
      </div>
    </Frame>
  );
}

function InputWidget({ req }: { req: Extract<Request, { kind: "input" }> }) {
  const { options } = req;
  const [value, setValue] = useState(options.value ?? "");
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const error = touched ? (options.validate?.(value) ?? null) : null;
  const finish = (v: string | undefined) => {
    close();
    req.resolve(v);
  };
  return (
    <Frame title={options.title} onCancel={() => finish(undefined)}>
      <div className="tm-qi-input-row">
        <input
          ref={ref}
          className={`tm-input ${error ? "has-error" : ""}`}
          type={options.password ? "password" : "text"}
          value={value}
          placeholder={options.placeholder}
          aria-label={options.prompt ?? options.placeholder ?? options.title ?? "Input"}
          aria-invalid={!!error}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setTouched(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const err = options.validate?.(value) ?? null;
              setTouched(true);
              if (!err) finish(value);
            } else if (e.key === "Escape") finish(undefined);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </div>
      <div className={`tm-qp-prompt ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
        {error ?? `${options.prompt ?? ""}${options.prompt ? " " : ""}(Press 'Enter' to confirm or 'Escape' to cancel)`}
      </div>
      {options.links?.length ? (
        <div className="tm-qp-links">
          {options.links.map((l) => (
            <button key={l.label} type="button" className="tm-link-button" onClick={l.run}>
              {l.label}
            </button>
          ))}
        </div>
      ) : null}
    </Frame>
  );
}
