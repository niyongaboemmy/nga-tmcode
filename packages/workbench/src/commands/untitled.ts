import { getDocument, markSaved, revertDocument, saveDocument, untitledSave } from "../monaco/documents";
import {
  activeFilePath,
  closeEditors,
  createEntry,
  getPlatform,
  notify,
  openFile,
  refreshExplorer,
  showDialog,
  useWorkbench,
  workbench,
} from "../state/store";
import { basename, dirname } from "../util/paths";
import { isUntitled, nextUntitledPath } from "../util/untitled";
import { showInputBox } from "../widgets/QuickPick";
import { registerCommand } from "./registry";

/** V8: New Untitled File (⌘N), Save As… and Revert File. */

const openPaths = () =>
  useWorkbench
    .getState()
    .groups.flatMap((g) => g.editors)
    .flatMap((e) => (e.kind === "file" ? [e.path] : []));

export function newUntitledFile() {
  const path = nextUntitledPath(openPaths());
  openFile(path, { pinned: true });
  return path;
}

/** A workspace-relative path a student typed: no "..", no absolute paths. */
export function validateSavePath(value: string): string | null {
  const v = value.trim().replace(/\\/g, "/");
  if (!v) return "Type a file name.";
  if (v.startsWith("/") || /^[a-zA-Z]:/.test(v)) return "Use a path inside this folder, like src/notes.txt.";
  if (v.split("/").some((p) => p === ".." || p === "." || p === "")) return "Use a path inside this folder, like src/notes.txt.";
  if (/[<>:"|?*\u0000]/.test(v)) return "A file name can't contain < > : \" | ? or *.";
  if (v.endsWith("/")) return "Type a file name, not a folder.";
  return null;
}

async function exists(path: string) {
  return getPlatform()
    .fs.readFile(path)
    .then(
      () => true,
      () => false,
    );
}

/**
 * Asks for a path and writes `from`'s text there, then swaps the editor to the
 * new file (as VS Code does). Throws when cancelled so a pending close stops.
 */
export async function saveAs(from: string): Promise<string | null> {
  const model = getDocument(from);
  if (!model) return null;
  if (!useWorkbench.getState().workspace) {
    notify("info", "Open a folder first, then save the file into it.");
    throw new Error("No folder open");
  }
  const suggested = isUntitled(from) ? "" : from;
  const value = await showInputBox({
    title: "Save As",
    prompt: "File path in this folder (for example notes.txt or src/app.js)",
    placeholder: "notes.txt",
    value: suggested,
    validate: validateSavePath,
  });
  if (value === undefined) throw new Error("Save As cancelled");
  const target = value.trim().replace(/\\/g, "/");
  if (target === from) {
    await saveDocument(from);
    return from;
  }
  const text = model.getValue();
  const groupId = useWorkbench.getState().groups.find((g) => g.editors.some((e) => e.kind === "file" && e.path === from))?.id ?? workbench.get().activeGroup;
  if (await exists(target)) {
    const choice = await showDialog({
      message: `'${basename(target)}' already exists. Do you want to replace it?`,
      detail: "Its contents will be replaced.",
      severity: "warning",
      buttons: [
        { id: "replace", label: "Replace", primary: true, destructive: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice !== "replace") throw new Error("Save As cancelled");
  } else {
    await createEntry(dirname(target), basename(target), "file");
  }
  const open = getDocument(target);
  if (open) {
    open.setValue(text);
    await saveDocument(target);
  } else {
    await getPlatform().fs.writeFile(target, text);
  }
  // A new folder on the way ("notes/hello.txt") shows in the explorer.
  await refreshExplorer();
  // The old editor closes without saving (an untitled buffer is gone; a file keeps what it had on disk).
  if (isUntitled(from)) markSaved(from);
  else await revertDocument(from);
  openFile(target, { pinned: true, group: groupId });
  const g = useWorkbench.getState().groups.find((x) => x.id === groupId);
  const old = g?.editors.find((e) => e.kind === "file" && e.path === from);
  if (g && old) await closeEditors(g.id, [old.id]);
  return target;
}

let registered = false;
export function registerUntitledCommands() {
  if (registered) return;
  registered = true;
  untitledSave.run = async (path) => {
    await saveAs(path);
  };
  registerCommand({
    id: "workbench.action.files.newUntitledFile",
    title: "New Text File",
    category: "File",
    keybinding: "mod+n",
    run: newUntitledFile,
  });
  registerCommand({
    id: "workbench.action.files.saveAs",
    title: "Save As...",
    category: "File",
    keybinding: "mod+shift+s",
    enabled: () => !!activeFilePath() && !!useWorkbench.getState().workspace,
    run: async () => {
      const path = activeFilePath();
      if (path) await saveAs(path).catch(() => {});
    },
  });
  registerCommand({
    id: "workbench.action.files.revert",
    title: "Revert File",
    category: "File",
    enabled: () => {
      const p = activeFilePath();
      return !!p && !!useWorkbench.getState().dirty[p];
    },
    run: async () => {
      const path = activeFilePath();
      if (!path) return;
      if (isUntitled(path)) {
        getDocument(path)?.setValue("");
        markSaved(path);
      } else await revertDocument(path);
    },
  });
}
