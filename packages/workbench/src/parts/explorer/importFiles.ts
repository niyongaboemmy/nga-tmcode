import { getPlatform, loadDir, log, notify, showDialog, toggleDir, useWorkbench } from "../../state/store";
import { join } from "../../util/paths";

/**
 * Files dragged in from Finder / File Explorer: copied (never moved) into the
 * folder they were dropped on, asking before replacing anything. Not in exams:
 * outside files can't be brought into an exam folder.
 */

function allowed() {
  if (useWorkbench.getState().policy.mode !== "practice") {
    notify("warning", "You can't drag files in during an exam.");
    return false;
  }
  return true;
}

async function confirmReplace(conflicts: string[], dest: string) {
  const where = dest || useWorkbench.getState().workspace?.name || "this folder";
  const choice = await showDialog({
    message:
      conflicts.length === 1
        ? `A file or folder named '${conflicts[0]}' already exists in '${where}'. Do you want to replace it?`
        : `${conflicts.length} files or folders already exist in '${where}'. Do you want to replace them?`,
    detail: conflicts.length > 1 ? conflicts.slice(0, 10).join("\n") : "This replaces what is there now.",
    severity: "warning",
    buttons: [
      { id: "replace", label: "Replace", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  return choice === "replace";
}

async function finish(dest: string, imported: string[]) {
  if (dest) await toggleDir(dest, true);
  await loadDir(dest);
  if (imported.length) useWorkbench.setState({ selection: imported[imported.length - 1] });
  log("Explorer", `Copied ${imported.length} item${imported.length === 1 ? "" : "s"} into ${dest || "/"}`);
}

/** Desktop: absolute paths from the OS drop. */
export async function importPaths(dest: string, sources: string[]) {
  const fs = getPlatform().fs;
  if (!sources.length || !fs.importPaths || !allowed()) return;
  try {
    let res = await fs.importPaths(sources, dest, false);
    if (res.conflicts.length) {
      if (!(await confirmReplace(res.conflicts, dest))) return;
      res = await fs.importPaths(sources, dest, true);
    }
    await finish(dest, res.imported);
  } catch (e) {
    notify("error", `Could not copy the files: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Browser build: File objects from an HTML drop (text files only). */
export async function importBrowserFiles(dest: string, files: File[]) {
  if (!files.length || !allowed()) return;
  const fs = getPlatform().fs;
  const existing = new Set((await fs.readDir(dest).catch(() => [])).map((e) => e.name));
  const conflicts = files.map((f) => f.name).filter((n) => existing.has(n));
  if (conflicts.length && !(await confirmReplace(conflicts, dest))) return;
  const imported: string[] = [];
  try {
    for (const f of files) {
      const path = join(dest, f.name);
      await fs.writeFile(path, await f.text());
      imported.push(path);
    }
  } catch (e) {
    notify("error", `Could not copy the files: ${String((e as Error)?.message ?? e)}`);
  }
  await finish(dest, imported);
}
