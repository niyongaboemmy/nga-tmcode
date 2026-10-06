import { useEffect, useState } from "react";
import { CancellationToken } from "monaco-editor/base/common/cancellation.js";
import { IOutlineModelService } from "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { codeEditorFor } from "../monaco/editors";
import { getDocument, onDocumentChanged } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import { activeFilePath, useWorkbench, workbench } from "../state/store";
import { Codicon } from "../widgets/icons";

/** VS Code's Outline: the active file's symbols from Monaco's language services (TS/JS, CSS, HTML, JSON, grammars with symbols). */

interface Sym {
  name: string;
  detail?: string;
  kind: number;
  range: monaco.IRange;
  selectionRange: monaco.IRange;
  children?: Sym[];
}

async function symbolsOf(model: monaco.editor.ITextModel): Promise<Sym[]> {
  const service = StandaloneServices.get(IOutlineModelService) as { getOrCreate(m: unknown, t: unknown): Promise<{ getTopLevelSymbols(): Sym[] }> };
  const outline = await service.getOrCreate(model, CancellationToken.None);
  return outline.getTopLevelSymbols();
}

/** SymbolKind.EnumMember → "symbol-enum-member". */
export function symbolIcon(kind: number) {
  const name = (monaco.languages.SymbolKind as unknown as Record<number, string>)[kind] ?? "misc";
  return `symbol-${name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

function reveal(sym: Sym) {
  const ed = codeEditorFor(workbench.get().activeGroup);
  if (!ed) return;
  // Some providers (TypeScript) give the whole declaration as the selection range: just put the cursor at its start.
  ed.setPosition({ lineNumber: sym.selectionRange.startLineNumber, column: sym.selectionRange.startColumn });
  ed.revealRangeInCenterIfOutsideViewport(sym.range);
  ed.focus();
}

function Node({ sym, depth, filter }: { sym: Sym; depth: number; filter: string }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = sym.children ?? [];
  const match = !filter || sym.name.toLowerCase().includes(filter);
  const childMatch = (s: Sym): boolean => s.name.toLowerCase().includes(filter) || (s.children ?? []).some(childMatch);
  if (filter && !match && !kids.some(childMatch)) return null;
  const expanded = open || (!!filter && kids.some(childMatch));
  return (
    <>
      <div
        className="tm-list-row tm-outline-row"
        role="treeitem"
        aria-expanded={kids.length ? expanded : undefined}
        tabIndex={0}
        style={{ paddingLeft: 12 + depth * 12 }}
        onClick={() => reveal(sym)}
        onKeyDown={(e) => e.key === "Enter" && reveal(sym)}
        title={`${sym.name}${sym.detail ? ` — ${sym.detail}` : ""} (line ${sym.range.startLineNumber})`}
      >
        <span
          className="tm-outline-twistie"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!expanded);
          }}
        >
          {kids.length > 0 && <Codicon name={expanded ? "chevron-down" : "chevron-right"} />}
        </span>
        <Codicon name={symbolIcon(sym.kind)} className={`tm-outline-icon is-${symbolIcon(sym.kind)}`} />
        <span className="tm-project-name">{sym.name}</span>
        {sym.detail && <span className="tm-project-meta">{sym.detail}</span>}
      </div>
      {expanded && kids.map((k, i) => <Node key={`${k.name}:${i}`} sym={k} depth={depth + 1} filter={filter} />)}
    </>
  );
}

export function OutlinePane() {
  const path = useWorkbench((s) => activeFilePath(s));
  const [open, setOpen] = useState(false);
  const [symbols, setSymbols] = useState<Sym[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const model = getDocument(path);
      if (!model) return void setTimeout(() => alive && load(), 300);
      void symbolsOf(model).then(
        (s) => alive && setSymbols(s),
        () => alive && setSymbols([]),
      );
    };
    setSymbols(null);
    load();
    const off = onDocumentChanged((p) => {
      if (p !== path) return;
      clearTimeout(timer);
      timer = setTimeout(load, 600);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [open, path]);

  return (
    <section className={`tm-pane tm-timeline tm-outline ${open ? "is-open" : "is-collapsed"}`} aria-label="Outline" data-testid="outline">
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">Outline</span>
      </div>
      {open && (
        <div className="tm-pane-body tm-scroll tm-timeline-body" role="tree" aria-label="Symbols">
          {!path ? (
            <p className="tm-muted tm-projects-hint">The active editor cannot provide outline information.</p>
          ) : symbols === null ? null : symbols.length === 0 ? (
            <p className="tm-muted tm-projects-hint">No symbols found in this document.</p>
          ) : (
            <>
              <div className="tm-input-box tm-projects-filter">
                <input className="tm-input" placeholder="Filter symbols" aria-label="Filter symbols" value={filter} onChange={(e) => setFilter(e.target.value.toLowerCase())} />
              </div>
              {symbols.map((s, i) => (
                <Node key={`${s.name}:${i}`} sym={s} depth={0} filter={filter} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
