/**
 * One folder of a workspace as the test-framework detection sees it (the same
 * shape as TMCode's `run/projectKind.ts` FolderSnapshot, kept here so this
 * package has no dependency on the workbench).
 */
export interface FolderSnapshot {
  /** Workspace-relative folder ("" = root). */
  dir: string;
  /** File names directly in the folder. */
  files: string[];
  /** Sub-folder names directly in the folder. */
  dirs: string[];
  /** Contents of the manifests that exist (only the first few KB). */
  read: Record<string, string>;
}

/** Folder snapshots (root plus every sub-folder) from a flat list of file paths. */
export function snapshotsOf(paths: string[], read: (path: string) => string | null | undefined = () => null): FolderSnapshot[] {
  const dirs = new Set<string>([""]);
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const childOf = (dir: string, p: string) => (dir ? p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/") : !p.includes("/"));
  return [...dirs].map((dir) => {
    const files = paths.filter((p) => childOf(dir, p)).map((p) => p.split("/").pop()!);
    const sub = [...dirs].filter((d) => d !== "" && d !== dir && childOf(dir, d)).map((d) => d.split("/").pop()!);
    const text: Record<string, string> = {};
    for (const n of files) {
      const t = read(dir ? `${dir}/${n}` : n);
      if (t != null) text[n] = t;
    }
    return { dir, files, dirs: sub, read: text };
  });
}
