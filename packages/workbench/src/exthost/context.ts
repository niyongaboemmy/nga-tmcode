import { codeEditorFor } from "../monaco/editors";
import { getPlatform, useWorkbench } from "../state/store";
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
  const ed = codeEditorFor(s.activeGroup);
  const model = ed?.getModel();
  const path = model?.uri.scheme === "tmcode" ? model.uri.path.replace(/^\//, "") : null;
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
      return path ? "file" : undefined;
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
      return s.readOnly;
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
