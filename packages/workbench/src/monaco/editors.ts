import type { monaco } from "./setup";

/** Live Monaco editor instances by editor group, so commands can act on "the" editor. */
const editors = new Map<number, monaco.editor.IStandaloneCodeEditor>();

export function registerCodeEditor(group: number, editor: monaco.editor.IStandaloneCodeEditor) {
  editors.set(group, editor);
  return () => {
    if (editors.get(group) === editor) editors.delete(group);
  };
}

export function codeEditorFor(group: number) {
  return editors.get(group) ?? null;
}

/** Runs a built-in Monaco action (e.g. "editor.action.formatDocument") on a group's editor. */
export function runEditorAction(group: number, actionId: string) {
  const ed = editors.get(group);
  if (!ed) return false;
  ed.focus();
  const action = ed.getAction(actionId);
  if (action) {
    void action.run();
    return true;
  }
  ed.trigger("tmcode", actionId, null);
  return true;
}
