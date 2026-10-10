import { useEffect, useRef, useState } from "react";
import { editorOptions } from "../parts/editor/CodeEditor";
import { ensureDocument, languageForPath, saveDocument } from "../monaco/documents";
import { monaco, monacoThemeFor, setupMonaco } from "../monaco/setup";
import { focusGroup, getPlatform, useWorkbench, type EditorInput } from "../state/store";
import { useGit } from "./gitService";
import { ActionButton } from "../widgets/icons";
import { hunkAction } from "./extras";

/** Inline (one column) instead of side by side; remembered for the session, as VS Code's toggle. */
let inlinePreferred = false;

type DiffInput = Extract<EditorInput, { kind: "gitDiff" }>;

/**
 * A git diff editor, like VS Code's: "Working Tree" changes compare the index
 * (left) with the file itself (right, editable, saved with ⌘S/Ctrl+S);
 * "Index" changes compare HEAD with the staged content (read-only).
 */
export function GitDiffEditor({ input, groupId }: { input: DiffInput; groupId: number }) {
  const host = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalRef = useRef<monaco.editor.ITextModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState(inlinePreferred);
  const settings = useWorkbench((s) => s.settings);
  const readOnly = useWorkbench((s) => s.readOnly);
  const theme = useWorkbench((s) => s.previewTheme ?? s.settings["workbench.colorTheme"]);
  const version = useGit((s) => s.version);
  const narrow = useWorkbench((s) => s.viewport === "xs" || s.viewport === "sm");
  const os = getPlatform().os;
  const editable = input.mode === "working" && !input.deleted;

  // Create the diff editor and the right-hand model once per input.
  useEffect(() => {
    setupMonaco();
    let disposed = false;
    const language = languageForPath(input.path);
    const original = monaco.editor.createModel("", language);
    originalRef.current = original;
    const diff = monaco.editor.createDiffEditor(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      originalEditable: false,
      readOnly: !editable,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 700,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      enableSplitViewResizing: true,
      ariaLabel: `${input.path} (${input.mode === "staged" ? "Index" : "Working Tree"})`,
    });
    diffRef.current = diff;
    let ownModified: monaco.editor.ITextModel | null = null;
    const attach = (modified: monaco.editor.ITextModel) => {
      if (disposed) return;
      diff.setModel({ original, modified });
    };
    const loadModified = async () => {
      if (editable) {
        const model = await ensureDocument(input.path);
        // If the file's tab closes, its model is disposed: pick up the new one.
        model.onWillDispose(() => setTimeout(() => !disposed && void loadModified(), 0));
        attach(model);
      } else {
        const git = getPlatform().git;
        const text = input.deleted ? "" : ((await git?.show(input.path, "index").catch(() => null)) ?? "");
        ownModified = monaco.editor.createModel(text, language);
        attach(ownModified);
      }
    };
    loadModified().catch((e) => !disposed && setError(String((e as Error)?.message ?? e)));
    const modifiedEditor = diff.getModifiedEditor();
    // ⌘S / Ctrl+S saves the working-tree file from the diff.
    modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveDocument(input.path));
    // Alt+F5 / Shift+Alt+F5: next / previous change, as in VS Code.
    modifiedEditor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F5, () => diff.goToDiff("next"));
    modifiedEditor.addCommand(monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.F5, () => diff.goToDiff("previous"));
    const focus = modifiedEditor.onDidFocusEditorText(() => focusGroup(groupId));
    return () => {
      disposed = true;
      focus.dispose();
      diff.setModel(null);
      diff.dispose();
      original.dispose();
      ownModified?.dispose();
      originalRef.current = null;
    };
  }, [input.path, input.mode, input.deleted, editable, groupId, os]);

  // The left side follows the repository (after staging, committing…).
  useEffect(() => {
    let live = true;
    const git = getPlatform().git;
    if (!git) return;
    void git
      .show(input.path, input.mode === "staged" ? "HEAD" : "index")
      .then((text) => {
        const m = originalRef.current;
        if (live && m && !m.isDisposed() && m.getValue() !== (text ?? "")) m.setValue(text ?? "");
        if (live) setError(null);
      })
      .catch((e) => live && setError(String(e) === "binary" || String((e as Error)?.message) === "binary" ? "This file is binary and can't be compared as text." : String((e as Error)?.message ?? e)));
    return () => {
      live = false;
    };
  }, [input.path, input.mode, version]);

  useEffect(() => {
    diffRef.current?.updateOptions({ ...editorOptions(settings, os), readOnly: !editable || readOnly, renderSideBySide: !narrow && !inline });
  }, [settings, os, editable, readOnly, narrow, inline]);

  /** The hunk under the cursor of the right-hand side (or the first change). */
  const cursorLine = () => diffRef.current?.getModifiedEditor().getPosition()?.lineNumber ?? diffRef.current?.getLineChanges()?.[0]?.modifiedStartLineNumber ?? 1;
  const go = (dir: "next" | "previous") => {
    const d = diffRef.current;
    if (!d) return;
    d.goToDiff(dir);
    d.getModifiedEditor().focus();
  };

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeFor(theme));
  }, [theme]);

  return (
    <div className="tm-code-editor tm-git-diff tm-history-compare" data-testid="git-diff">
      <div className="tm-compare-bar tm-diff-actions" role="toolbar" aria-label="Diff editor actions">
        <span className="tm-compare-side">{input.mode === "staged" ? "HEAD ↔ Index" : "Index ↔ Working Tree"}</span>
        <span className="tm-compare-actions">
          {editable && (
            <>
              <ActionButton icon="add" label="Stage Change at Cursor" onClick={() => void hunkAction(input.path, cursorLine(), "stage", { nearest: true })} />
              <ActionButton icon="discard" label="Revert Change at Cursor" onClick={() => void hunkAction(input.path, cursorLine(), "revert", { nearest: true })} />
            </>
          )}
          {input.mode === "staged" && !input.deleted && <ActionButton icon="remove" label="Unstage Change at Cursor" onClick={() => void hunkAction(input.path, cursorLine(), "unstage", { nearest: true })} />}
          <ActionButton icon="arrow-up" label="Previous Change (Shift+Alt+F5)" onClick={() => go("previous")} />
          <ActionButton icon="arrow-down" label="Next Change (Alt+F5)" onClick={() => go("next")} />
          <ActionButton
            icon={inline ? "split-horizontal" : "diff-single"}
            label={inline ? "Show Side by Side" : "Show Inline"}
            aria-pressed={inline}
            onClick={() => {
              inlinePreferred = !inline;
              setInline(!inline);
            }}
          />
        </span>
      </div>
      <div ref={host} className="tm-monaco-host monaco-component" />
      {error && (
        <div className="tm-editor-error" role="alert">
          <code>{error}</code>
        </div>
      )}
    </div>
  );
}
