import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { revealInEditor } from "../../monaco/reveal";
import { expandable, parseStack, previewOf, type JsValue } from "../../run/jsInspect";
import { evaluateInJsConsole, expandRef, useJsConsole, type ConsoleEntry } from "../../run/jsConsole";
import { Codicon } from "../../widgets/icons";

/** A clickable "file:line:col" of a stack frame. */
function FrameLink({ path, line, column, children }: { path: string; line: number; column: number; children: ReactNode }) {
  return (
    <button type="button" className="tm-jsv-link" title={`Go to ${path}:${line}:${column}`} onClick={() => revealInEditor(path, line, column)}>
      {children}
    </button>
  );
}

/** A stack with its workspace frames as links. */
export function StackView({ stack, skipFirst = true }: { stack: string; skipFirst?: boolean }) {
  const all = parseStack(stack);
  // V8 stacks start with "TypeError: message" (already shown); JavaScriptCore stacks are frames only.
  const header = skipFirst && all.length > 0 && !/^\s*at\s|@/.test(all[0].text);
  const lines = all.slice(header ? 1 : 0, 12);
  return (
    <div className="tm-jsv-stack">
      {lines.map((l, i) => {
        if (!l.path) return <div key={i} className="tm-jsv-frame is-external">{l.text.trim()}</div>;
        const at = l.text.indexOf(l.path);
        const loc = `${l.path}:${l.line}${/:\d+:\d+/.test(l.text.slice(at)) ? `:${l.column}` : ""}`;
        return (
          <div key={i} className="tm-jsv-frame">
            {l.text.slice(0, at).trimStart()}
            <FrameLink path={l.path} line={l.line!} column={l.column ?? 1}>
              {loc}
            </FrameLink>
            {l.text.slice(at + loc.length)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One value, as the devtools console shows it: primitives coloured by type,
 * objects collapsed to a preview with a twistie that loads their children.
 */
export function JsValueView({ value, name, top = false, load = expandRef }: { value: JsValue; name?: string; top?: boolean; load?: (ref: number) => Promise<[string, JsValue][]> }) {
  const [open, setOpen] = useState(top && value.t === "err");
  const [children, setChildren] = useState<[string, JsValue][] | null>(value.t === "obj" ? value.entries : null);
  const [loading, setLoading] = useState(false);
  const label =
    name !== undefined ? (
      <>
        <span className="tm-jsv-key">{name}</span>
        <span className="tm-jsv-colon">: </span>
      </>
    ) : null;

  if (!expandable(value)) {
    return (
      <span className="tm-jsv">
        {label}
        <Primitive value={value} top={top && name === undefined} />
      </span>
    );
  }

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && value.t === "obj" && !children && value.ref !== undefined) {
      setLoading(true);
      setChildren(await load(value.ref));
      setLoading(false);
    }
  };

  return (
    <span className={`tm-jsv is-tree ${open ? "is-open" : ""}`}>
      <span
        className="tm-jsv-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => void toggle()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || (e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
            e.preventDefault();
            void toggle();
          }
        }}
      >
        <Codicon name={open ? "chevron-down" : "chevron-right"} className="tm-jsv-twistie" />
        {label}
        {value.t === "err" ? (
          <span className="tm-jsv-error">
            {value.name}: {value.message}
          </span>
        ) : (
          <span className={`tm-jsv-preview ${open ? "is-dim" : ""}`}>{previewOf(value, name !== undefined)}</span>
        )}
      </span>
      {open && value.t === "err" && <StackView stack={value.stack} />}
      {open && value.t === "obj" && (
        <span className="tm-jsv-children" role="group">
          {loading && <span className="tm-jsv-row tm-muted">Loading…</span>}
          {children?.map(([k, v]) => (
            <span key={k} className="tm-jsv-row">
              <JsValueView value={v} name={value.kind === "map" ? `${k} =>` : k} load={load} />
            </span>
          ))}
          {value.more ? <span className="tm-jsv-row tm-muted">… {value.more} more</span> : null}
          {value.size !== undefined && value.kind === "array" && (
            <span className="tm-jsv-row">
              <span className="tm-jsv-key is-meta">length</span>
              <span className="tm-jsv-colon">: </span>
              <span className="tm-jsv-num">{value.size}</span>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function Primitive({ value, top }: { value: JsValue; top: boolean }) {
  switch (value.t) {
    case "str":
      return <span className={top ? "tm-jsv-text" : "tm-jsv-str"}>{top ? value.v : JSON.stringify(value.v)}</span>;
    case "num":
    case "bigint":
      return <span className="tm-jsv-num">{value.v}</span>;
    case "bool":
      return <span className="tm-jsv-bool">{value.v}</span>;
    case "undef":
    case "null":
      return <span className="tm-jsv-null">{value.v}</span>;
    case "sym":
      return <span className="tm-jsv-str">{value.v}</span>;
    case "fn":
      return <span className="tm-jsv-fn">{value.v}</span>;
    case "circ":
      return <span className="tm-jsv-null">[Circular]</span>;
    case "err":
      return (
        <span className="tm-jsv-error">
          {value.name}: {value.message}
        </span>
      );
    case "obj":
      return <span className={value.kind === "dom" ? "tm-jsv-dom" : value.kind === "regexp" ? "tm-jsv-str" : "tm-jsv-preview"}>{previewOf(value)}</span>;
  }
}

/** Console arguments separated by spaces, as console.log prints them. */
export function JsArgs({ args, load }: { args: JsValue[]; load?: (ref: number) => Promise<[string, JsValue][]> }) {
  return (
    <>
      {args.map((a, i) => (
        <span key={i} className="tm-jsc-arg">
          {i > 0 ? " " : ""}
          <JsValueView value={a} top load={load} />
        </span>
      ))}
    </>
  );
}

const LEVEL_ICON: Partial<Record<ConsoleEntry["level"], string>> = { error: "error", warn: "warning", info: "info", input: "chevron-right", result: "arrow-small-left" };

function EntryRow({ e }: { e: ConsoleEntry }) {
  if (e.level === "system") {
    return (
      <div className={`tm-jsc-entry is-system ${e.outcome ? `is-${e.outcome}` : ""}`} role="listitem">
        <Codicon name={e.outcome === "ok" ? "pass" : e.outcome === "error" ? "error" : e.outcome === "stopped" ? "debug-stop" : "play"} />
        <span>{e.text}</span>
      </div>
    );
  }
  return (
    <div className={`tm-jsc-entry is-${e.level}`} role="listitem" style={e.group ? { paddingLeft: 8 + e.group * 14 } : undefined}>
      <span className="tm-jsc-gutter">{LEVEL_ICON[e.level] ? <Codicon name={LEVEL_ICON[e.level]!} /> : null}</span>
      <span className="tm-jsc-args">
        {e.level === "input" ? <span className="tm-jsc-input-echo">{e.args[0]?.t === "str" ? e.args[0].v : ""}</span> : <JsArgs args={e.args} />}
        {e.trace && <StackView stack={e.trace} skipFirst={false} />}
      </span>
      {e.count > 1 && <span className="tm-console-count">{e.count}</span>}
    </div>
  );
}

const text = (e: ConsoleEntry) => (e.text ?? "") + e.args.map((a) => previewOf(a)).join(" ");

/** The JavaScript Console panel: a program's structured console output plus a REPL line. */
export function JsConsoleView({ visible, filter }: { visible: boolean; filter: string }) {
  const entries = useJsConsole((s) => s.entries);
  const history = useJsConsole((s) => s.history);
  const status = useJsConsole((s) => s.status);
  const [draft, setDraft] = useState("");
  const [hist, setHist] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shown = filter ? entries.filter((e) => text(e).toLowerCase().includes(filter.toLowerCase())) : entries;

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown.length, entries]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [visible]);

  const submit = () => {
    if (!draft.trim()) return;
    const code = draft;
    setDraft("");
    setHist(-1);
    void evaluateInJsConsole(code);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && el.selectionStart === 0 && history.length) {
      e.preventDefault();
      const i = Math.min(history.length - 1, hist + 1);
      setHist(i);
      setDraft(history[i]);
    } else if (e.key === "ArrowDown" && el.selectionEnd === el.value.length && hist >= 0) {
      e.preventDefault();
      const i = hist - 1;
      setHist(i);
      setDraft(i < 0 ? "" : history[i]);
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      useJsConsole.setState({ entries: [] });
    }
  };

  return (
    <div className="tm-jsc" hidden={!visible} data-testid="js-console">
      <div
        ref={listRef}
        className="tm-jsc-list tm-scroll tm-mono"
        role="list"
        aria-label="JavaScript Console"
        aria-live="polite"
        onClick={(e) => e.target === e.currentTarget && inputRef.current?.focus()}
      >
        {entries.length === 0 && (
          <div className="tm-jsc-empty">
            <Codicon name="debug-console" />
            <div>
              Run a JavaScript or TypeScript file here with <b>Run in JavaScript Console</b> (▶ menu), or type an expression below.
              <div className="tm-muted">Objects expand and errors link to your code. The code runs in a sandboxed worker, like a browser tab without a page.</div>
            </div>
          </div>
        )}
        {shown.map((e) => (
          <EntryRow key={e.id} e={e} />
        ))}
      </div>
      <div className={`tm-jsc-prompt ${status === "running" ? "is-busy" : ""}`}>
        <Codicon name={status === "running" ? "loading" : "chevron-right"} className={status === "running" ? "codicon-modifier-spin" : ""} />
        <textarea
          ref={inputRef}
          className="tm-jsc-input tm-mono"
          rows={Math.min(6, draft.split("\n").length)}
          value={draft}
          spellCheck={false}
          placeholder="Evaluate JavaScript (Enter to run, Shift+Enter for a new line)"
          aria-label="JavaScript Console input"
          data-testid="js-console-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
      </div>
    </div>
  );
}
