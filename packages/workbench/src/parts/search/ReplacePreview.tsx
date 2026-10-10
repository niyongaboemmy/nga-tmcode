import { useEffect, useRef } from "react";
import { languageForPath } from "../../monaco/documents";
import { monaco, monacoThemeFor, setupMonaco } from "../../monaco/setup";
import { getPlatform, useWorkbench } from "../../state/store";
import { editorOptions } from "../editor/CodeEditor";
import { ActionButton } from "../../widgets/icons";

export interface ReplacePreviewState {
  path: string;
  before: string;
  after: string;
  count: number;
  /** One match ("line:start"): the diff scrolls to it. */
  line?: number;
}

/** VS Code's "file ↔ file (Replace Preview)": the file now (left) and after the replace (right). */
export function ReplacePreview({ state, onReplace, onClose }: { state: ReplacePreviewState; onReplace: () => void; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const os = getPlatform().os;

  useEffect(() => {
    setupMonaco();
    const lang = languageForPath(state.path);
    const original = monaco.editor.createModel(state.before, lang);
    const modified = monaco.editor.createModel(state.after, lang);
    const diff = monaco.editor.createDiffEditor(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      theme: monacoThemeFor(),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 700,
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
      ariaLabel: `${state.path}: before and after the replace`,
    });
    diff.setModel({ original, modified });
    if (state.line) setTimeout(() => diff.getModifiedEditor().revealLineInCenter(state.line!), 50);
    replaceRef.current?.focus();
    return () => {
      diff.setModel(null);
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [state, os]);

  return (
    <div className="tm-dialog-backdrop tm-replace-preview-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="tm-replace-preview"
        role="dialog"
        aria-modal="true"
        aria-label={`Replace Preview: ${state.path}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="tm-replace-preview-header">
          <span className="tm-replace-preview-title">
            {state.path} <span className="tm-muted">(Replace Preview)</span>
          </span>
          <span className="tm-muted">
            {state.count} change{state.count === 1 ? "" : "s"}
          </span>
          <ActionButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div ref={host} className="tm-replace-preview-diff monaco-component" data-testid="replace-preview-diff" />
        <footer className="tm-replace-preview-footer">
          <button type="button" className="tm-button tm-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button ref={replaceRef} type="button" className="tm-button" disabled={!state.count} onClick={onReplace}>
            Replace
          </button>
        </footer>
      </div>
    </div>
  );
}
