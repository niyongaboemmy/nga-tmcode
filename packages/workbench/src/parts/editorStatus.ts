import { create } from "zustand";
import { registerCommand } from "../commands/registry";
import { ensureDocument, getDocument, languageForPath, markSaved, onDocumentSaved } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import type { FileEncoding } from "../platform/types";
import { activeFilePath, getPlatform, notify, revealView, setEditorInfo, updateSetting, useWorkbench } from "../state/store";
import { showQuickPick, type PickItem } from "../widgets/QuickPick";
import { openReplaceInFiles } from "./search/SearchView";
import { initWindowZoom, zoomIn, zoomOut, zoomReset } from "../state/windowZoom";
import { convertIndentation } from "../util/indentation";

/**
 * The editor items of the status bar, as in VS Code: the file's own
 * indentation (Spaces: 4 / Tab Size: 4), end of line, encoding and language,
 * each opening its picker. Also the whole-window zoom and screen reader
 * commands.
 */

export interface ActiveFileInfo {
  path: string | null;
  tabSize: number;
  insertSpaces: boolean;
  encoding: FileEncoding | null;
}

export const useActiveFileInfo = create<ActiveFileInfo>(() => ({ path: null, tabSize: 4, insertSpaces: true, encoding: null }));

export const ENCODINGS: { id: FileEncoding; label: string }[] = [
  { id: "utf8", label: "UTF-8" },
  { id: "utf8bom", label: "UTF-8 with BOM" },
  { id: "utf16le", label: "UTF-16 LE" },
  { id: "utf16be", label: "UTF-16 BE" },
  { id: "windows1252", label: "Western (Windows 1252)" },
  { id: "iso88591", label: "Western (ISO 8859-1)" },
];

export const encodingLabel = (id: FileEncoding | null) => (id === "windows1252" ? "Windows 1252" : id === "iso88591" ? "ISO 8859-1" : (ENCODINGS.find((e) => e.id === id)?.label ?? "UTF-8"));

function activeModel() {
  const path = activeFilePath();
  return path ? getDocument(path) : null;
}

let optionsListener: monaco.IDisposable | null = null;

/** Follows the active file: its model's indentation options and its encoding on disk. */
async function refresh() {
  const path = activeFilePath();
  optionsListener?.dispose();
  optionsListener = null;
  if (!path) {
    useActiveFileInfo.setState({ path: null, encoding: null });
    return;
  }
  const model = await ensureDocument(path).catch(() => null);
  if (activeFilePath() !== path) return;
  if (model && !model.isDisposed()) {
    const read = () => {
      const o = model.getOptions();
      useActiveFileInfo.setState({ path, tabSize: o.tabSize, insertSpaces: o.insertSpaces });
    };
    read();
    optionsListener = model.onDidChangeOptions(read);
  }
  const encoding = (await getPlatform().fs.encodingOf?.(path).catch(() => null)) ?? "utf8";
  if (activeFilePath() === path) useActiveFileInfo.setState({ path, encoding });
}

let wired = false;
export function wireEditorStatus() {
  if (wired) return;
  wired = true;
  let last: string | null = null;
  useWorkbench.subscribe((s) => {
    const path = activeFilePath(s);
    if (path !== last) {
      last = path;
      void refresh();
    }
  });
  onDocumentSaved((path) => path === activeFilePath() && void refresh());
  void refresh();
}

// ───────────── pickers ─────────────

async function pickTabSize(title: string, current: number) {
  const items: PickItem[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: String(n), label: String(n), description: n === current ? "Current" : undefined }));
  const picked = await showQuickPick({ title, placeholder: "Select Tab Size for Current File", items });
  return picked ? Number(picked.id) : null;
}

export async function pickIndentation() {
  const model = activeModel();
  if (!model) return;
  const o = model.getOptions();
  const action = await showQuickPick({
    placeholder: "Select Action",
    items: [
      { id: "spaces", label: "Indent Using Spaces", separator: "change view" },
      { id: "tabs", label: "Indent Using Tabs" },
      { id: "display", label: "Change Tab Display Size" },
      { id: "detect", label: "Detect Indentation from Content" },
      { id: "toSpaces", label: "Convert Indentation to Spaces", separator: "convert file" },
      { id: "toTabs", label: "Convert Indentation to Tabs" },
    ],
  });
  if (!action || model.isDisposed()) return;
  switch (action.id) {
    case "spaces":
    case "tabs": {
      const n = await pickTabSize(action.label, o.tabSize);
      if (n) model.updateOptions({ insertSpaces: action.id === "spaces", tabSize: n, indentSize: n });
      break;
    }
    case "display": {
      const n = await pickTabSize(action.label, o.tabSize);
      if (n) model.updateOptions({ tabSize: n });
      break;
    }
    case "detect": {
      const s = useWorkbench.getState().settings;
      model.detectIndentation(s["editor.insertSpaces"], s["editor.tabSize"]);
      break;
    }
    case "toSpaces":
    case "toTabs": {
      const toSpaces = action.id === "toSpaces";
      const text = model.getValue();
      const next = convertIndentation(text, toSpaces, o.tabSize);
      if (next !== text) {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
        model.pushStackElement();
      }
      model.updateOptions({ insertSpaces: toSpaces });
      break;
    }
  }
}

export async function pickEol() {
  const model = activeModel();
  if (!model) return;
  const current = model.getEOL() === "\r\n" ? "CRLF" : "LF";
  const picked = await showQuickPick({
    placeholder: "Select End of Line Sequence",
    items: [
      { id: "LF", label: "LF", description: current === "LF" ? "Current" : "macOS and Linux" },
      { id: "CRLF", label: "CRLF", description: current === "CRLF" ? "Current" : "Windows" },
    ],
  });
  if (!picked || picked.id === current || model.isDisposed()) return;
  model.pushEOL(picked.id === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  setEditorInfo({ language: model.getLanguageId(), eol: picked.id as "LF" | "CRLF" });
}

export async function pickEncoding() {
  const path = activeFilePath();
  const fs = getPlatform().fs;
  const model = activeModel();
  if (!path || !model) return;
  if (!fs.encodingOf || !fs.reopenWithEncoding || !fs.setEncoding) {
    notify("info", "This file is UTF-8. Other encodings need the TMCode desktop app.");
    return;
  }
  const current = (await fs.encodingOf(path).catch(() => "utf8" as FileEncoding)) ?? "utf8";
  const mode = await showQuickPick({
    placeholder: "Select Action",
    items: [
      { id: "reopen", label: "Reopen with Encoding" },
      { id: "save", label: "Save with Encoding" },
    ],
  });
  if (!mode) return;
  const picked = await showQuickPick({
    placeholder: mode.id === "reopen" ? "Select File Encoding to Reopen File" : "Select File Encoding to Save with",
    items: ENCODINGS.map((e) => ({ id: e.id, label: e.label, description: e.id === current ? "Current" : undefined })),
  });
  if (!picked || model.isDisposed()) return;
  const encoding = picked.id as FileEncoding;
  if (mode.id === "reopen") {
    if (useWorkbench.getState().dirty[path]) {
      notify("warning", "Save or revert your changes before reopening the file with another encoding.");
      return;
    }
    try {
      const text = await fs.reopenWithEncoding(path, encoding);
      model.setValue(text);
      markSaved(path);
    } catch (e) {
      notify("error", `Could not reopen '${path}' as ${picked.label}: ${String((e as Error)?.message ?? e)}`);
    }
  } else {
    try {
      await fs.setEncoding(path, encoding);
      await fs.writeFile(path, model.getValue());
      markSaved(path);
    } catch (e) {
      await fs.setEncoding(path, current).catch(() => {});
      notify("error", `Could not save '${path}' as ${picked.label}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  await refresh();
}

export async function pickLanguage() {
  const path = activeFilePath();
  const model = activeModel();
  if (!path || !model) return;
  const current = model.getLanguageId();
  const langs = monaco.languages
    .getLanguages()
    .filter((l) => l.aliases?.length)
    .map((l) => ({ id: l.id, label: l.aliases![0], description: l.id === current ? `(${l.id}) - Current` : `(${l.id})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const auto = languageForPath(path);
  const picked = await showQuickPick({
    placeholder: "Select Language Mode",
    matchOnDescription: true,
    items: [{ id: "__auto__", label: "Auto Detect", description: `(${auto})`, separator: "" }, ...langs],
  });
  if (!picked || model.isDisposed()) return;
  const id = picked.id === "__auto__" ? auto : picked.id;
  monaco.editor.setModelLanguage(model, id);
  setEditorInfo({ language: id, eol: model.getEOL() === "\r\n" ? "CRLF" : "LF" });
}

export function toggleScreenReaderMode() {
  const on = useWorkbench.getState().settings["editor.accessibilitySupport"] === "on";
  updateSetting("editor.accessibilitySupport", on ? "off" : "on");
  notify("info", on ? "Screen reader mode is off." : "Screen reader mode is on: the editor is optimised for screen readers.");
}

const hasFile = () => !!activeFilePath();

export function registerFilesSearchCommands() {
  registerCommand({ id: "workbench.action.replaceInFiles", title: "Replace in Files", category: "Search", keybinding: "mod+shift+h", enabled: () => !!useWorkbench.getState().workspace, run: () => {
    revealView("search");
    openReplaceInFiles();
  } });
  registerCommand({ id: "workbench.action.editor.changeLanguageMode", title: "Change Language Mode", category: "Editor", keybinding: "mod+k m", enabled: hasFile, run: pickLanguage });
  registerCommand({ id: "workbench.action.editor.changeEOL", title: "Change End of Line Sequence", category: "Editor", enabled: hasFile, run: pickEol });
  registerCommand({ id: "workbench.action.editor.changeEncoding", title: "Change File Encoding", category: "Editor", enabled: hasFile, run: pickEncoding });
  registerCommand({ id: "editor.action.changeIndentation", title: "Change Indentation", category: "Editor", enabled: hasFile, run: pickIndentation });
  registerCommand({ id: "workbench.action.zoomIn", title: "Zoom In", category: "View", keybinding: "mod+=", run: zoomIn });
  registerCommand({ id: "workbench.action.zoomOut", title: "Zoom Out", category: "View", keybinding: "mod+-", run: zoomOut });
  registerCommand({ id: "workbench.action.zoomReset", title: "Reset Zoom", category: "View", keybinding: "mod+0", run: zoomReset });
  registerCommand({ id: "editor.action.toggleScreenReaderAccessibilityMode", title: "Toggle Screen Reader Accessibility Mode", category: "Accessibility", keybinding: "shift+alt+f1", run: toggleScreenReaderMode });
  wireEditorStatus();
  initWindowZoom();
}
