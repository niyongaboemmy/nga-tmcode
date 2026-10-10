import { registerCommand } from "../commands/registry";
import { ensureDocument, getDocument, pathOfUri } from "../monaco/documents";
import { codeEditorFor, onCodeEditor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { activeEditor, activeFilePath, notify, openContextMenu, openEditorInput, useWorkbench } from "../state/store";
import { parseConflicts, resolveAll, resolveConflict, type ConflictChoice } from "./conflicts";
import { describeHunk, hunkAtLine, hunksBetween, revertHunk, stageHunk } from "./hunks";
import { gitHost, scheduleRefresh, showGitError, useGit } from "./gitService";

const ACCEPT = "_tmcode.merge.accept";
const COMPARE = "_tmcode.merge.compare";

/** Replaces a document's text as one undoable edit, keeping each editor's cursor and scroll. */
function replaceText(model: monaco.editor.ITextModel, text: string) {
  const views = monaco.editor
    .getEditors()
    .filter((e) => e.getModel() === model)
    .map((e) => [e, e.saveViewState()] as const);
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
  for (const [e, vs] of views) if (vs) e.restoreViewState(vs);
}

// ───────────── merge conflicts: CodeLens + colours ─────────────

/** Accept Current / Incoming / Both for the conflict starting at `start` (1-based). */
export function acceptConflict(model: monaco.editor.ITextModel, start: number, choice: ConflictChoice) {
  const text = model.getValue();
  const c = parseConflicts(text).find((x) => x.start === start);
  if (!c) return false;
  replaceText(model, resolveConflict(text, c, choice));
  return true;
}

function compareConflict(path: string, start: number) {
  const c = parseConflicts(getDocument(path)?.getValue() ?? "").find((x) => x.start === start);
  if (!c) return;
  openEditorInput({
    kind: "historyDiff",
    id: `conflict:${path}:${start}`,
    path,
    entry: String(start),
    time: Date.now(),
    preview: false,
    source: "conflict",
    label: `${c.currentLabel || "Current"} ↔ ${c.incomingLabel || "Incoming"}`,
  });
}

/** The two sides of a conflict, for the Compare Changes editor. */
export function conflictSides(path: string, start: number): { current: string; incoming: string } | null {
  const c = parseConflicts(getDocument(path)?.getValue() ?? "").find((x) => x.start === start);
  return c ? { current: c.current.join("\n"), incoming: c.incoming.join("\n") } : null;
}

function wireConflicts() {
  monaco.editor.registerCommand(ACCEPT, (_a, uri: string, start: number, choice: ConflictChoice) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) acceptConflict(model, start, choice);
  });
  monaco.editor.registerCommand(COMPARE, (_a, path: string, start: number) => compareConflict(path, start));
  const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses(model) {
      if (model.uri.scheme !== "tmcode") return { lenses: [], dispose() {} };
      const conflicts = parseConflicts(model.getValue());
      const uri = model.uri.toString();
      const path = pathOfUri(model.uri);
      const lenses = conflicts.flatMap((c) => {
        const range = new monaco.Range(c.start, 1, c.start, 1);
        return [
          { range, command: { id: ACCEPT, title: "Accept Current Change", arguments: [uri, c.start, "current"] } },
          { range, command: { id: ACCEPT, title: "Accept Incoming Change", arguments: [uri, c.start, "incoming"] } },
          { range, command: { id: ACCEPT, title: "Accept Both Changes", arguments: [uri, c.start, "both"] } },
          { range, command: { id: COMPARE, title: "Compare Changes", arguments: [path, c.start] } },
        ];
      });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("*", provider);

  // VS Code's colours: current (green) and incoming (blue) blocks, stronger on the marker lines.
  onCodeEditor((editor) => {
    const deco = editor.createDecorationsCollection();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const model = editor.getModel();
        if (!model) return deco.clear();
        const text = model.getValue();
        if (!text.includes("<<<<<<<")) return deco.clear();
        const out: monaco.editor.IModelDeltaDecoration[] = [];
        const line = (from: number, to: number, cls: string) =>
          to >= from && out.push({ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className: cls } });
        for (const c of parseConflicts(text)) {
          line(c.start, c.start, "tm-merge-current-header");
          line(c.start + 1, (c.base ?? c.middle) - 1, "tm-merge-current");
          if (c.base) line(c.base, c.middle - 1, "tm-merge-base");
          line(c.middle + 1, c.end - 1, "tm-merge-incoming");
          line(c.end, c.end, "tm-merge-incoming-header");
        }
        deco.set(out);
      }, 150);
    };
    const subs = [editor.onDidChangeModel(update), editor.onDidChangeModelContent(update)];
    editor.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      if (timer) clearTimeout(timer);
    });
    update();
  });
}

// ───────────── hunks: Stage Change / Revert Change ─────────────

/**
 * Stages or reverts the change at a line of a working-tree file: Stage writes
 * the index version with that one change applied; Revert puts the staged
 * lines back in the editor (undoable, not saved).
 */
export async function hunkAction(path: string, line: number, op: "stage" | "revert" | "unstage", opts: { nearest?: boolean } = {}) {
  // The diff editor's buttons take the change at the cursor, else the next one (else the first).
  const pick = (hunks: ReturnType<typeof hunksBetween>) => hunkAtLine(hunks, line) ?? (opts.nearest ? (hunks.find((h) => h.modStart + 1 >= line) ?? hunks[0] ?? null) : null);
  const git = gitHost();
  if (!git) return notify("info", "Source Control is not available here.");
  const model = await ensureDocument(path);
  const entry = useGit.getState().status?.entries.find((e) => e.path === path);
  if (entry?.kind === "untracked" && op === "stage") {
    // A new file is one change: stage all of it.
    try {
      await git.stage([path]);
      scheduleRefresh(50);
    } catch (e) {
      showGitError(e);
    }
    return;
  }
  try {
    if (op === "unstage") {
      const head = (await git.show(path, "HEAD")) ?? "";
      const index = (await git.show(path, "index")) ?? "";
      const h = pick(hunksBetween(head, index));
      if (!h) return notify("info", "There is no staged change at this line.");
      if (!git.stageContent) return notify("info", "Unstaging part of a file needs the desktop app.");
      await git.stageContent(path, revertHunk(head, index, h));
      scheduleRefresh(50);
      return;
    }
    const base = (await git.show(path, "index")) ?? "";
    const current = model.getValue();
    const h = pick(hunksBetween(base, current));
    if (!h) return notify("info", "There is no change at this line.");
    if (op === "revert") {
      replaceText(model, revertHunk(base, current, h));
      return;
    }
    if (!git.stageContent) return notify("info", "Staging part of a file needs the desktop app.");
    await git.stageContent(path, stageHunk(base, current, h));
    scheduleRefresh(50);
  } catch (e) {
    showGitError(e);
  }
}

/** Clicking a quick-diff bar in the gutter: Stage Change / Revert Change for that hunk, as VS Code's peek offers. */
function wireGutterMenu() {
  onCodeEditor((editor) => {
    const sub = editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
      const model = editor.getModel();
      if (!model || !gitHost()) return;
      const line = e.target.position.lineNumber;
      const marked = model.getLineDecorations(line).some((d) => /tm-dirty-diff-/.test(d.options.linesDecorationsClassName ?? ""));
      if (!marked) return;
      const path = pathOfUri(model.uri);
      const ev = e.event.browserEvent;
      void (async () => {
        const base = (await gitHost()?.show(path, "index").catch(() => null)) ?? "";
        const h = hunkAtLine(hunksBetween(base, model.getValue()), line);
        const what = h ? ` (${describeHunk(h)})` : "";
        openContextMenu(ev.clientX, ev.clientY, [
          { kind: "item", label: `Stage Change${what}`, run: () => void hunkAction(path, line, "stage") },
          { kind: "item", label: `Revert Change${what}`, danger: true, run: () => void hunkAction(path, line, "revert") },
        ]);
      })();
    });
    editor.onDidDispose(() => sub.dispose());
  });
}

/** The file and line the cursor is on, in a code editor or a working-tree diff. */
function cursorTarget(): { path: string; line: number; staged: boolean } | null {
  const s = useWorkbench.getState();
  const e = activeEditor(s);
  if (e?.kind === "file") {
    const line = codeEditorFor(s.activeGroup)?.getPosition()?.lineNumber;
    return line ? { path: e.path, line, staged: false } : null;
  }
  if (e?.kind === "gitDiff") {
    const ed = monaco.editor.getEditors().find((x) => x.hasTextFocus() || x.hasWidgetFocus()) ?? monaco.editor.getEditors().find((x) => x.getModel()?.uri.scheme === "tmcode" && pathOfUri(x.getModel()!.uri) === e.path);
    return { path: e.path, line: ed?.getPosition()?.lineNumber ?? 1, staged: e.mode === "staged" };
  }
  return null;
}

let registered = false;
export function registerScmExtras() {
  if (registered) return;
  registered = true;
  wireConflicts();
  wireGutterMenu();
  const canHunk = () => !!gitHost() && !!useGit.getState().status && !!cursorTarget();
  registerCommand({
    id: "git.stageSelectedRanges",
    title: "Stage Selected Ranges",
    category: "Git",
    keybinding: "mod+k mod+alt+s",
    enabled: canHunk,
    run: () => {
      const t = cursorTarget();
      if (t) void hunkAction(t.path, t.line, t.staged ? "unstage" : "stage");
    },
  });
  registerCommand({
    id: "git.revertSelectedRanges",
    title: "Revert Selected Ranges",
    category: "Git",
    enabled: () => canHunk() && !cursorTarget()?.staged,
    run: () => {
      const t = cursorTarget();
      if (t) void hunkAction(t.path, t.line, "revert");
    },
  });
  registerCommand({
    id: "git.unstageSelectedRanges",
    title: "Unstage Selected Ranges",
    category: "Git",
    enabled: canHunk,
    run: () => {
      const t = cursorTarget();
      if (t) void hunkAction(t.path, t.line, "unstage");
    },
  });
  const conflictModel = () => {
    const p = activeFilePath();
    const m = p ? getDocument(p) : null;
    return m && parseConflicts(m.getValue()).length ? m : null;
  };
  for (const [choice, label] of [
    ["current", "Current"],
    ["incoming", "Incoming"],
    ["both", "Both"],
  ] as const) {
    registerCommand({
      id: `merge-conflict.accept.all-${choice}`,
      title: `Accept All ${label}`,
      category: "Merge Conflict",
      enabled: () => !!conflictModel(),
      run: () => {
        const m = conflictModel();
        if (m) replaceText(m, resolveAll(m.getValue(), choice));
      },
    });
  }
  registerCommand({
    id: "merge-conflict.next",
    title: "Next Conflict",
    category: "Merge Conflict",
    enabled: () => !!conflictModel(),
    run: () => {
      const s = useWorkbench.getState();
      const ed = codeEditorFor(s.activeGroup);
      const m = conflictModel();
      if (!ed || !m) return;
      const line = ed.getPosition()?.lineNumber ?? 0;
      const all = parseConflicts(m.getValue());
      const next = all.find((c) => c.start > line) ?? all[0];
      if (next) {
        ed.setPosition({ lineNumber: next.start, column: 1 });
        ed.revealLineInCenter(next.start);
        ed.focus();
      }
    },
  });
}
