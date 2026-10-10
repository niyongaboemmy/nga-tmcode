/**
 * File › Open Recent: recent folders, then the open folder's recently opened
 * files, as VS Code's picker lists them. Pure (unit-tested).
 */

export interface RecentFolder {
  name: string;
  root: string;
}

export interface RecentItem {
  kind: "folder" | "file";
  /** Folder root, or workspace-relative file path. */
  target: string;
  label: string;
  description: string;
  separator?: string;
}

const tail = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const parent = (p: string) => {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return parts.join("/");
};
const readable = (root: string) => root.replace(/^memory:\/\//, "");

/**
 * The current folder is left out (it is already open); folders come first,
 * then files of the current folder (at most `maxFiles`), each list without
 * duplicates.
 */
export function recentItems(folders: RecentFolder[], files: string[], currentRoot: string | null, maxFiles = 20): RecentItem[] {
  const seen = new Set<string>();
  const out: RecentItem[] = [];
  for (const f of folders) {
    if (f.root === currentRoot || seen.has(f.root)) continue;
    seen.add(f.root);
    out.push({ kind: "folder", target: f.root, label: f.name || tail(f.root), description: readable(parent(f.root)) || readable(f.root) });
  }
  const fileSeen = new Set<string>();
  const fileItems: RecentItem[] = [];
  for (const p of files) {
    if (fileSeen.has(p) || fileItems.length >= maxFiles) continue;
    fileSeen.add(p);
    fileItems.push({ kind: "file", target: p, label: tail(p), description: parent(p) });
  }
  if (out.length) out[0] = { ...out[0], separator: "folders" };
  if (fileItems.length) fileItems[0] = { ...fileItems[0], separator: "recent files" };
  return [...out, ...fileItems];
}
