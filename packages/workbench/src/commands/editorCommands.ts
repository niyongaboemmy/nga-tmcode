import { monaco } from "../monaco/setup";
import { codeEditorFor } from "../monaco/editors";
import { workbench } from "../state/store";
import { executeCommand, getCommand, isEnabled, registerCommand } from "./registry";

/**
 * Editor commands that follow focus (V7): Undo, Find and Select All act on
 * whatever has focus — an editor (any, diff editors included), a text field
 * or the terminal — instead of always the active editor. Also the Monaco
 * actions behind the Selection and Go menus.
 */

export type FocusTarget =
  | { kind: "editor"; editor: monaco.editor.ICodeEditor }
  | { kind: "input"; el: HTMLInputElement | HTMLTextAreaElement | HTMLElement }
  | { kind: "terminal" }
  | { kind: "none" };

export function focusTarget(): FocusTarget {
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest(".xterm")) return { kind: "terminal" };
  const focused = monaco.editor.getEditors().find((e) => e.hasTextFocus());
  if (focused) return { kind: "editor", editor: focused };
  // The palette, a menu or a dialog has focus only while it's open: commands run after focus goes back.
  if (el?.closest(".tm-quick-input, .tm-menu, .tm-dialog")) return { kind: "none" };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el?.isContentEditable) return { kind: "input", el };
  return { kind: "none" };
}

/** The editor a menu or palette action should act on: the focused one, else the active group's (never while typing elsewhere). */
export function targetEditor(): monaco.editor.ICodeEditor | null {
  const t = focusTarget();
  if (t.kind === "editor") return t.editor;
  if (t.kind !== "none") return null;
  return codeEditorFor(workbench.get().activeGroup);
}

/** Runs a Monaco action (or core command such as "undo") on the target editor. */
export function runOnEditor(id: string, ed = targetEditor()) {
  if (!ed) return false;
  ed.focus();
  const action = ed.getAction(id);
  if (action) void action.run();
  else ed.trigger("menu", id, null);
  return true;
}

function routedUndo(which: "undo" | "redo") {
  const t = focusTarget();
  if (t.kind === "terminal") return;
  if (t.kind === "input") {
    document.execCommand(which);
    return;
  }
  const ed = t.kind === "editor" ? t.editor : codeEditorFor(workbench.get().activeGroup);
  if (!ed) return;
  ed.focus();
  ed.trigger("menu", which, null);
}

function routedFind() {
  const t = focusTarget();
  if (t.kind === "terminal") {
    const c = getCommand("workbench.action.terminal.focusFind");
    if (c && isEnabled(c)) executeCommand(c.id);
    return;
  }
  if (t.kind === "input") return;
  runOnEditor("actions.find", t.kind === "editor" ? t.editor : codeEditorFor(workbench.get().activeGroup));
}

const canEdit = () => {
  const t = focusTarget();
  return t.kind === "input" || t.kind === "editor" || !!codeEditorFor(workbench.get().activeGroup);
};

/** Monaco actions with their own Monaco keys (shown in menus, palette and the shortcuts list). */
const EDITOR_ACTIONS: [id: string, title: string, category?: string][] = [
  ["editor.action.smartSelect.expand", "Expand Selection", "Selection"],
  ["editor.action.smartSelect.shrink", "Shrink Selection", "Selection"],
  ["editor.action.copyLinesUpAction", "Copy Line Up", "Selection"],
  ["editor.action.copyLinesDownAction", "Copy Line Down", "Selection"],
  ["editor.action.moveLinesUpAction", "Move Line Up", "Selection"],
  ["editor.action.moveLinesDownAction", "Move Line Down", "Selection"],
  ["editor.action.insertCursorAbove", "Add Cursor Above", "Selection"],
  ["editor.action.insertCursorBelow", "Add Cursor Below", "Selection"],
  ["editor.action.addSelectionToNextFindMatch", "Add Next Occurrence", "Selection"],
  ["editor.action.selectHighlights", "Select All Occurrences", "Selection"],
  ["editor.action.marker.nextInFiles", "Next Problem", "Go"],
  ["editor.action.marker.prevInFiles", "Previous Problem", "Go"],
];

export function registerEditorCommands() {
  const hasEditor = () => !!targetEditor();
  for (const [id, title, category] of EDITOR_ACTIONS) {
    registerCommand({ id, title, category, editorOwned: true, enabled: hasEditor, run: () => runOnEditor(id) });
  }
  // These replace the plain wrappers in builtin.ts: same ids, focus-aware.
  registerCommand({ id: "undo", title: "Undo", category: "Edit", editorOwned: true, enabled: canEdit, run: () => routedUndo("undo") });
  registerCommand({ id: "redo", title: "Redo", category: "Edit", editorOwned: true, enabled: canEdit, run: () => routedUndo("redo") });
  registerCommand({ id: "actions.find", title: "Find", category: "Edit", editorOwned: true, enabled: () => focusTarget().kind !== "input" && (hasEditor() || focusTarget().kind === "terminal"), run: routedFind });
  registerCommand({
    id: "editor.action.selectAll",
    title: "Select All",
    category: "Edit",
    editorOwned: true,
    enabled: canEdit,
    // The same routing as the native Edit › Select All (developer.ts).
    run: () => executeCommand("workbench.action.selectAllInFocus"),
  });
}
