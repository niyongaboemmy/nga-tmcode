import { useEffect, useRef, useState } from "react";
import { editorOptions } from "../parts/editor/CodeEditor";
import { ensureDocument, languageForPath } from "../monaco/documents";
import { monaco, setupMonaco } from "../monaco/setup";
import { closeEditors, getPlatform, useWorkbench, type EditorInput } from "../state/store";
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
    const grading = input.source === "grading";
    const conflict = input.source === "conflict";
    let ownModified: monaco.editor.ITextModel | null = null;
    const diff = monaco.editor.createDiffEditor(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      originalEditable: false,
      // Grading compares two versions of a student's work, a conflict its two sides: nothing to edit.
      readOnly: grading || conflict,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 700,
      ignoreTrimWhitespace: false,
      ariaLabel: input.source === "taskMentor" ? `${input.path}: Task Mentor's copy ↔ yours` : grading ? `${input.path}: ${input.label ?? "version"} ↔ submitted` : `${input.path} (Local History) ↔ current`,
    });
    void (async () => {
      try {
        if (conflict) {
          // Merge conflict: the current side (left) against the incoming side (right).
          const { conflictSides } = await import("../scm/extras");
          const sides = conflictSides(input.path, Number(input.entry));
          if (!sides) throw new Error("the conflict was resolved");
          original.setValue(sides.current);
          ownModified = monaco.editor.createModel(sides.incoming, languageForPath(input.path));
          if (!disposed) diff.setModel({ original, modified: ownModified });
          return;
        }
        if (input.source === "git") {
          // Timeline: the file in a commit (left) against the file now (right, editable).
          const text = await getPlatform().git?.showAt?.(input.path, input.entry);
          original.setValue(text ?? "");
          const modified = await ensureDocument(input.path);
          if (!disposed) diff.setModel({ original, modified });
          return;
        }
        if (grading) {
          // Left: that version of the student's work; right: the submitted file (or nothing, when it was deleted).
          const { leftText } = await import("../grading/diff");
          original.setValue(await leftText(input.entry, input.path));
          const exists = await getPlatform()
            .fs.readFile(input.path)
            .then(() => true)
            .catch(() => false);
          const modified = exists ? await ensureDocument(input.path) : (ownModified = monaco.editor.createModel("", languageForPath(input.path)));
          if (!disposed) diff.setModel({ original, modified });
          return;
        }
        // A conflict's Compare: Task Mentor's copy (left) against this folder's file (right).
        original.setValue(input.source === "taskMentor" ? await getPlatform().fs.readFile(input.entry) : await readHistory(input.path, input.entry));
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
      ownModified?.dispose();
    };
  }, [input.path, input.entry, os]);

  const compare = input.source === "taskMentor";
  const resolve = (keep: "mine" | "theirs") =>
    void import("../projects/service").then(async (m) => {
      await m.resolveConflict(input.path, keep);
      const group = useWorkbench.getState().groups.find((g) => g.editors.some((e) => e.id === input.id));
      if (group) await closeEditors(group.id, [input.id]);
    });
  return (
    <div className={`tm-code-editor tm-git-diff ${compare || input.source ? "tm-history-compare" : ""}`} data-testid="history-diff">
      {compare && (
        <div className="tm-compare-bar" data-testid="conflict-compare">
          <span className="tm-compare-side">Task Mentor's copy</span>
          <span className="codicon codicon-arrow-both" aria-hidden />
          <span className="tm-compare-side">Yours (this folder)</span>
          <span className="tm-compare-actions">
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => resolve("mine")}>
              Keep Mine
            </button>
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => resolve("theirs")}>
              Take Task Mentor's
            </button>
          </span>
        </div>
      )}
      {(input.source === "git" || input.source === "conflict") && (
        <div className="tm-compare-bar" data-testid={input.source === "git" ? "git-timeline-diff" : "merge-compare"}>
          <span className="tm-compare-side">{input.label ?? input.entry}</span>
          <span className="codicon codicon-arrow-both" aria-hidden />
          <span className="tm-compare-side">{input.source === "git" ? "Now" : "Incoming"}</span>
        </div>
      )}
      {input.source === "grading" && (
        <div className="tm-compare-bar" data-testid="grading-diff">
          <span className="tm-compare-side">{input.label ?? "Version"}</span>
          <span className="codicon codicon-arrow-right" aria-hidden />
          <span className="tm-compare-side">Submitted</span>
        </div>
      )}
      <div ref={host} className="tm-monaco-host monaco-component" />
      {error && (
        <div className="tm-editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
