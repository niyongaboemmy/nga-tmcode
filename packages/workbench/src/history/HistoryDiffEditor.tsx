import { useEffect, useRef, useState } from "react";
import { editorOptions } from "../parts/editor/CodeEditor";
import { ensureDocument, languageForPath } from "../monaco/documents";
import { monaco, setupMonaco } from "../monaco/setup";
import { getPlatform, useWorkbench, type EditorInput } from "../state/store";
import { readHistory } from "./localHistory";

type Input = Extract<EditorInput, { kind: "historyDiff" }>;

/** A saved copy from Local History (left, read-only) against the file as it is now (right, editable). */
export function HistoryDiffEditor({ input }: { input: Input }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const os = getPlatform().os;

  useEffect(() => {
    setupMonaco();
    let disposed = false;
    const original = monaco.editor.createModel("", languageForPath(input.path));
    const diff = monaco.editor.createDiffEditor(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 700,
      ignoreTrimWhitespace: false,
      ariaLabel: `${input.path} (Local History) ↔ current`,
    });
    void (async () => {
      try {
        original.setValue(await readHistory(input.path, input.entry));
        const modified = await ensureDocument(input.path);
        if (!disposed) diff.setModel({ original, modified });
      } catch (e) {
        if (!disposed) setError(`This version is not available any more (${String((e as Error)?.message ?? e)}).`);
      }
    })();
    return () => {
      disposed = true;
      diff.setModel(null);
      diff.dispose();
      original.dispose();
    };
  }, [input.path, input.entry, os]);

  return (
    <div className="tm-code-editor tm-git-diff" data-testid="history-diff">
      <div ref={host} className="tm-monaco-host monaco-component" />
      {error && (
        <div className="tm-editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
