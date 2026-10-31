import { create } from "zustand";
import { parseJsonc } from "../textmate/jsonc";
import { getPlatform, notify, openPathFromOs, useWorkbench } from "./store";
import { showQuickPick } from "../widgets/QuickPick";

/**
 * `.code-workspace` files (VS Code's multi-root workspaces). TMCode shows one
 * folder at a time: opening the file opens its first folder, and the status
 * bar switches between its folders (in this window, or a new one).
 */

export interface WorkspaceFolderRef {
  name: string;
  /** Absolute path. */
  path: string;
}

const KEY = "workspaceFile";

/** The folders a .code-workspace file lists, made absolute (relative ones are relative to the file). Pure. */
export function parseWorkspaceFile(text: string, fileDir: string): WorkspaceFolderRef[] {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch {
    return [];
  }
  const list = (raw as { folders?: unknown })?.folders;
  if (!Array.isArray(list)) return [];
  const win = fileDir.includes("\\") && !fileDir.includes("/");
  const sep = win ? "\\" : "/";
  const out: WorkspaceFolderRef[] = [];
  for (const f of list) {
    const p = (f as { path?: unknown })?.path;
    if (typeof p !== "string" || !p.trim()) continue;
    const isAbs = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
    const joined = isAbs ? p : `${fileDir.replace(/[\\/]+$/, "")}${sep}${p.replace(/^\.[\\/]/, "")}`;
    // "a/../b" and "./" in relative paths.
    const parts: string[] = [];
    for (const part of joined.split(/[\\/]/)) {
      if (part === "..") parts.pop();
      else if (part !== "." && !(part === "" && parts.length > 0)) parts.push(part);
    }
    const path = parts.join(sep) || sep;
    const name = typeof (f as { name?: unknown }).name === "string" ? (f as { name: string }).name : path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    if (!out.some((x) => x.path === path)) out.push({ name, path });
  }
  return out;
}

export const useWorkspaceFile = create<{ file: string | null; folders: WorkspaceFolderRef[] }>(() => ({ file: null, folders: [] }));

/** After a .code-workspace file was opened (as a file in its folder): open its first folder. */
export async function openWorkspaceFile(absFile: string, text: string): Promise<boolean> {
  const dir = absFile.replace(/[\\/][^\\/]*$/, "");
  const folders = parseWorkspaceFile(text, dir);
  if (!folders.length) {
    notify("warning", "This workspace file lists no folders.");
    return false;
  }
  useWorkspaceFile.setState({ file: absFile, folders });
  await getPlatform()
    .store.set(KEY, { file: absFile, folders })
    .catch(() => undefined);
  if (folders.length > 1) notify("info", `This workspace has ${folders.length} folders. TMCode shows one at a time: switch with the folder button in the status bar.`);
  return openPathFromOs(folders[0].path);
}

/** Status bar: pick another folder of the workspace. */
export async function switchWorkspaceFolder() {
  const { folders } = useWorkspaceFile.getState();
  const root = useWorkbench.getState().workspace?.root;
  const pick = await showQuickPick({
    placeholder: "Select a folder of this workspace",
    items: folders.map((f) => ({ id: f.path, label: f.name, description: f.path === root ? `${f.path} · current` : f.path, icon: "root-folder" })),
  });
  if (pick && pick.id !== root) await openPathFromOs(pick.id);
}

/** Is a path (a file the host opened) a .code-workspace file? */
export const isWorkspaceFile = (path: string | undefined | null) => !!path && /\.code-workspace$/i.test(path);

let wired = false;
export function wireWorkspaceFile() {
  if (wired) return;
  wired = true;
  // The workspace file opened last: its folders stay switchable while one of them is open.
  void getPlatform()
    .store.get<{ file: string; folders: WorkspaceFolderRef[] }>(KEY)
    .then((saved) => saved?.folders?.length && useWorkspaceFile.setState(saved))
    .catch(() => undefined);
}
