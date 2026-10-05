import type { monaco } from "./setup";

/** Live Monaco editor instances by editor group, so commands can act on "the" editor. */
const editors = new Map<number, monaco.editor.IStandaloneCodeEditor>();

const registered = new Set<(editor: monaco.editor.IStandaloneCodeEditor) => void>();
/** Called for every group editor created from now on (and the existing ones), e.g. git gutter marks. */
export function onCodeEditor(listener: (editor: monaco.editor.IStandaloneCodeEditor) => void) {
  registered.add(listener);
  editors.forEach((e) => listener(e));
  return () => registered.delete(listener);
}

export function registerCodeEditor(group: number, editor: monaco.editor.IStandaloneCodeEditor) {
  editors.set(group, editor);
  registered.forEach((l) => l(editor));
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
