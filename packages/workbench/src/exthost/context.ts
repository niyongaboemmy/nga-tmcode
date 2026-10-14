import { codeEditorFor, diffEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { virtualIO } from "../util/virtual";
import { activeEditor, getPlatform, useWorkbench } from "../state/store";
import { basename, extname } from "../util/paths";
import { extContextKeys } from "./state";
import { configValue } from "./config";
import { evaluateWhen } from "./when";

/**
 * The context keys TMCode provides for `when` clauses (VS Code's names), plus
 * whatever extensions set with `setContext`.
 */
export function contextKey(key: string): unknown {
  const s = useWorkbench.getState();
  // A diff tab's editor is its right side (an extension's proposed edit, a Compare).
  const ed = activeEditor(s)?.kind === "historyDiff" ? diffEditorFor(s.activeGroup) : codeEditorFor(s.activeGroup);
  const model = ed?.getModel();
  const virtual = !!model && virtualIO.schemes.has(model.uri.scheme);
  const path = model?.uri.scheme === "tmcode" ? model.uri.path.replace(/^\//, "") : virtual ? model!.uri.path : null;
  switch (key) {
    case "editorLangId":
    case "resourceLangId":
      return model?.getLanguageId();
    case "resourceExtname":
      return path ? (extname(path) ? `.${extname(path)}` : "") : undefined;
    case "resourceFilename":
      return path ? basename(path) : undefined;
    case "resourcePath":
    case "resource":
      return path ?? undefined;
    case "resourceScheme":
      return virtual ? model!.uri.scheme : path ? "file" : undefined;
    case "isInDiffEditor":
      return activeEditor(s)?.kind === "historyDiff";
    case "auxiliaryBarVisible":
      return s.auxiliaryVisible;
    case "activeAuxiliary":
      return s.auxiliaryVisible ? s.auxiliaryView : undefined;
    case "resourceDirname":
      return path ? path.split("/").slice(0, -1).join("/") : undefined;
    case "editorIsOpen":
      return !!model;
    case "editorFocus":
    case "editorTextFocus":
    case "textInputFocus":
      return !!ed?.hasTextFocus();
    case "inputFocus":
      return !!document.activeElement?.closest("input, textarea, .monaco-editor");
    case "editorHasSelection":
      return !!ed?.getSelection() && !ed.getSelection()!.isEmpty();
    case "editorHasMultipleSelections":
      return (ed?.getSelections()?.length ?? 0) > 1;
    case "editorReadonly":
      return s.readOnly || (!!ed && !!ed.getOption(monaco.editor.EditorOption.readOnly));
    case "isMac":
      return getPlatform().os === "mac";
    case "isWindows":
      return getPlatform().os === "windows";
    case "isLinux":
      return getPlatform().os === "linux";
    case "isWeb":
      return getPlatform().kind === "web";
    case "workspaceFolderCount":
      return s.workspace ? 1 : 0;
    case "workbenchState":
      return s.workspace ? "folder" : "empty";
    case "isWorkspaceTrusted":
      return true;
    case "panelVisible":
      return s.panelVisible;
    case "sideBarVisible":
      return s.sidebarVisible;
  }
  if (key.startsWith("config.")) return configValue(key.slice("config.".length));
  return extContextKeys.get(key);
}

export function when(clause: string | undefined): boolean {
  return evaluateWhen(clause, contextKey);
}
