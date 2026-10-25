import { create } from "zustand";
import { getPlatform, loadDir, moveEntry, notify, select, targetFolder, toggleDir, useWorkbench } from "../../state/store";
import { basename, dirname, join } from "../../util/paths";
import { recordCreated, recordMove } from "./fileUndo";
import { recordFileClipboard } from "../../activity/sources";

/**
 * VS Code's Explorer clipboard: Copy / Cut (⌘C / ⌘X) remember paths, Paste
 * (⌘V) copies or moves them into the selected folder, Duplicate copies in place.
 * Copies are named like VS Code's ("main copy.py", "main copy 2.py"). Files copied in
 * Finder / File Explorer paste too. Every paste can be undone (⌘Z in the Explorer, fileUndo.ts).
 */
export const useFileClipboard = create<{ mode: "copy" | "cut"; paths: string[] } | null>(() => null);

/** "a/main.py" → "main copy.py", then "main copy 2.py"… (folders: "src copy"). */
export function copyName(name: string, taken: (n: string) => boolean, isDir = false): string {
  const dot = isDir ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} copy${n === 1 ? "" : ` ${n}`}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} copy ${Date.now()}${ext}`;
}

// What the OS clipboard held when TMCode's own clipboard was set: a newer OS copy (Finder) wins on Paste.
let osAtCopy = "";
const osFiles = async () => (await getPlatform().fs.clipboardFiles?.().catch(() => [] as string[])) ?? [];

export function copyEntries(paths: string[]) {
  if (!paths.length) return;
  recordFileClipboard("copy", paths);
  useFileClipboard.setState({ mode: "copy", paths }, true);
  void osFiles().then((f) => (osAtCopy = f.join("\n")));
}

export function cutEntries(paths: string[]) {
  if (!paths.length) return;
  recordFileClipboard("cut", paths);
  useFileClipboard.setState({ mode: "cut", paths }, true);
  void osFiles().then((f) => (osAtCopy = f.join("\n")));
}

async function namesIn(dir: string) {
  return new Set((await getPlatform().fs.readDir(dir)).map((e) => e.name));
}

function isDirPath(path: string) {
  return Object.values(useWorkbench.getState().dirs).some((l) => l.some((e) => e.path === path && e.kind === "dir"));
}

async function copyInto(path: string, dest: string) {
  const fs = getPlatform().fs;
  if (!fs.copy) throw new Error("Copying files is not supported here.");
  const names = await namesIn(dest);
  const name = names.has(basename(path)) ? copyName(basename(path), (n) => names.has(n), isDirPath(path)) : basename(path);
  const to = join(dest, name);
  await fs.copy(path, to);
  return to;
}

export async function pasteEntries(dest = targetFolder()) {
  // Files copied in Finder / Windows Explorer since TMCode's last Copy: import them into this folder.
  const os = await osFiles();
  if (os.length && os.join("\n") !== osAtCopy) {
    const { importPaths } = await import("./importFiles");
    return importPaths(dest, os);
  }
  const clip = useFileClipboard.getState();
  if (!clip) {
    // Said, not silent: a paste that does nothing looks broken.
    notify("info", "Nothing to paste. Copy or cut files here first, or copy them in your computer's file manager.", undefined, { kind: "hint" });
    return;
  }
  let last: string | null = null;
  const created: string[] = [];
  const moved: { from: string; to: string }[] = [];
  try {
    for (const path of clip.paths) {
      if (clip.mode === "copy") {
        last = await copyInto(path, dest);
        created.push(last);
      } else {
        if (dirname(path) === dest) continue; // cut and pasted in place: nothing to do
        const names = await namesIn(dest);
        const name = names.has(basename(path)) ? copyName(basename(path), (n) => names.has(n), isDirPath(path)) : basename(path);
        await moveEntry(path, join(dest, name));
        last = join(dest, name);
        moved.push({ from: path, to: last });
      }
    }
    if (clip.mode === "cut") useFileClipboard.setState(null, true);
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  } finally {
    const what = (n: number) => (n === 1 ? `'${basename(last ?? "")}'` : `${n} items`);
    if (created.length) recordCreated(`paste of ${what(created.length)}`, created);
    if (moved.length) recordMove(`move of ${what(moved.length)}`, moved);
    // The result is shown: the folder opens, the last pasted item is selected and said.
    if (dest) await toggleDir(dest, true);
    await loadDir(dest);
    if (last) {
      select(last);
      const n = clip.paths.length;
      notify("info", `${clip.mode === "cut" ? "Moved" : "Copied"} ${n === 1 ? `"${basename(last)}"` : `${n} items`} to ${dest || "the project folder"}.`, undefined, { kind: "result" });
    }
  }
}

/** Option/Alt-drag in the tree: copies (never moves) the entries into `dest`. */
export async function copyPathsInto(paths: string[], dest: string) {
  const created: string[] = [];
  try {
    for (const path of paths) if (path && path !== dest) created.push(await copyInto(path, dest));
  } catch (e) {
    notify("error", `Could not copy: ${String((e as Error)?.message ?? e)}`);
  }
  if (dest) await toggleDir(dest, true);
  await loadDir(dest);
  if (!created.length) return;
  select(created[created.length - 1]);
  recordCreated(`copy of ${created.length === 1 ? `'${basename(created[0])}'` : `${created.length} items`}`, created);
  notify("info", `Copied ${created.length === 1 ? `"${basename(created[0])}"` : `${created.length} items`} to ${dest || "the project folder"}.`, undefined, { kind: "result" });
}

export async function duplicateEntry(path: string) {
  try {
    const to = await copyInto(path, dirname(path));
    recordCreated(`duplicate of '${basename(path)}'`, [to]);
    if (dirname(path)) await toggleDir(dirname(path), true);
    await loadDir(dirname(path));
    select(to);
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  }
}
