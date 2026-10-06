import { create } from "zustand";
import { getPlatform, loadDir, moveEntry, notify, select, targetFolder, useWorkbench } from "../../state/store";
import { basename, dirname, join } from "../../util/paths";

/**
 * VS Code's Explorer clipboard: Copy / Cut (⌘C / ⌘X) remember paths, Paste
 * (⌘V) copies or moves them into the selected folder, Duplicate copies in place.
 * Copies are named like VS Code's ("main copy.py", "main copy 2.py").
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

export function copyEntries(paths: string[]) {
  if (paths.length) useFileClipboard.setState({ mode: "copy", paths }, true);
}

export function cutEntries(paths: string[]) {
  if (paths.length) useFileClipboard.setState({ mode: "cut", paths }, true);
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
  const clip = useFileClipboard.getState();
  if (!clip) return;
  let last: string | null = null;
  try {
    for (const path of clip.paths) {
      if (clip.mode === "copy") last = await copyInto(path, dest);
      else {
        if (dirname(path) === dest) continue; // cut and pasted in place: nothing to do
        const names = await namesIn(dest);
        const name = names.has(basename(path)) ? copyName(basename(path), (n) => names.has(n), isDirPath(path)) : basename(path);
        await moveEntry(path, join(dest, name));
        last = join(dest, name);
      }
    }
    if (clip.mode === "cut") useFileClipboard.setState(null, true);
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  } finally {
    await loadDir(dest);
    if (last) select(last);
  }
}

export async function duplicateEntry(path: string) {
  try {
    const to = await copyInto(path, dirname(path));
    await loadDir(dirname(path));
    select(to);
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  }
}
