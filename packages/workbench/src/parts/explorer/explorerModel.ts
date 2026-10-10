import type { DirEntry } from "../../platform/types";
import type { PathMatcher } from "../../util/glob";

/**
 * The Explorer's visible rows: the expanded tree flattened, with `files.exclude`
 * applied and compact folders (a folder holding only one folder shares its
 * row, "src/main/java", as in VS Code).
 */
export interface Row {
  /** The row's entry; for a compact row, the deepest folder of the chain. */
  entry: DirEntry;
  depth: number;
  /** Compact row: every folder of the chain, top first (length > 1). */
  chain?: DirEntry[];
}

export interface RowOptions {
  exclude: PathMatcher;
  compact: boolean;
}

export function visibleChildren(dirs: Record<string, DirEntry[]>, path: string, exclude: PathMatcher): DirEntry[] | undefined {
  return dirs[path]?.filter((e) => !exclude(e.path));
}

/** The compact chain starting at folder `entry` (just [entry] when it doesn't compact). */
export function compactChain(dirs: Record<string, DirEntry[]>, entry: DirEntry, exclude: PathMatcher): DirEntry[] {
  const chain = [entry];
  let cur = entry;
  for (let i = 0; i < 64; i++) {
    const kids = visibleChildren(dirs, cur.path, exclude);
    if (!kids || kids.length !== 1 || kids[0].kind !== "dir") break;
    cur = kids[0];
    chain.push(cur);
  }
  return chain;
}

export function visibleRows(dirs: Record<string, DirEntry[]>, expanded: Record<string, true>, opts: RowOptions): Row[] {
  const rows: Row[] = [];
  const walk = (path: string, depth: number) => {
    for (const entry of visibleChildren(dirs, path, opts.exclude) ?? []) {
      if (entry.kind !== "dir") {
        rows.push({ entry, depth });
        continue;
      }
      const chain = opts.compact ? compactChain(dirs, entry, opts.exclude) : [entry];
      const tail = chain[chain.length - 1];
      rows.push(chain.length > 1 ? { entry: tail, depth, chain } : { entry, depth });
      if (expanded[tail.path]) walk(tail.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

export const rowLabel = (r: Row) => (r.chain ? r.chain.map((e) => e.name).join("/") : r.entry.name);

/** Paths of the rows between two paths, inclusive (Shift-click, Shift+arrows). */
export function rangeBetween(rows: Row[], a: string | null, b: string): string[] {
  const ib = rows.findIndex((r) => r.entry.path === b);
  const ia = a == null ? -1 : rows.findIndex((r) => r.entry.path === a);
  if (ib < 0) return [];
  if (ia < 0) return [b];
  const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
  return rows.slice(lo, hi + 1).map((r) => r.entry.path);
}

/**
 * Type-ahead: the next row (after `from`, wrapping) whose name starts with
 * `prefix`. With a longer prefix the current row may still match.
 */
export function typeAheadMatch(rows: Row[], from: number, prefix: string): number {
  if (!rows.length || !prefix) return -1;
  const p = prefix.toLowerCase();
  const start = prefix.length > 1 ? Math.max(0, from) : from + 1;
  for (let k = 0; k < rows.length; k++) {
    const i = (start + k + rows.length) % rows.length;
    if (rowLabel(rows[i]).toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

/** Top-level paths only: a folder's contents go with it in bulk moves and deletes. */
export function topLevelPaths(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)));
}
