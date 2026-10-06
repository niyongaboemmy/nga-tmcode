import { getDocument } from "./documents";
import { getPlatform, loadDir, notify, setDirty, useWorkbench } from "../state/store";
import { dirname } from "../util/paths";
import { markSaved } from "./documents";

/**
 * Applies changes made outside TMCode (watcher events): refresh the loaded
 * explorer folders, reload open files that have no unsaved edits (keeping
 * undo history), and warn about files changed under unsaved edits.
 */
export async function applyExternalChanges(paths: string[]) {
  const s = useWorkbench.getState();
  const dirs = new Set<string>();
  for (const p of paths) {
    if (s.dirs[p]) dirs.add(p);
    // New folders (a pull or checkout creating notes/todo.md): reload the nearest folder already shown.
    let d = dirname(p);
    while (d && !s.dirs[d]) d = dirname(d);
    if (s.dirs[d]) dirs.add(d);
  }
  await Promise.all([...dirs].map((d) => loadDir(d)));

  const fs = getPlatform().fs;
  for (const p of paths) {
    const model = getDocument(p);
    if (!model) continue;
    const disk = await fs.readFile(p).catch(() => null);
    if (disk === null || disk === model.getValue()) continue;
    if (useWorkbench.getState().dirty[p]) {
      notify("warning", `'${p}' was changed on disk while you have unsaved changes. Saving will overwrite the file on disk.`, [
        {
          label: "Discard my changes",
          run: () => {
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: disk }], () => null);
            markSaved(p);
            setDirty(p, false);
          },
        },
      ]);
      continue;
    }
    // Replace as one edit so Undo can bring the previous text back.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: disk }], () => null);
    markSaved(p);
  }
}
