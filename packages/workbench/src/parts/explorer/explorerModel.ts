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
  /** File nesting: the files shown under this file (package-lock.json under package.json). */
  nested?: DirEntry[];
  /** Find in the Explorer: where the name matches the query. */
  match?: [number, number];
}

export interface RowOptions {
  exclude: PathMatcher;
  compact: boolean;
  /** File nesting rules (explorer.fileNesting.patterns), when it is on. */
  nesting?: Record<string, string>;
}

/** VS Code's suggested file nesting patterns (explorer.fileNesting.patterns), the common ones. */
export const DEFAULT_NESTING: Record<string, string> = {
  "*.ts": "${capture}.js, ${capture}.d.ts, ${capture}.js.map",
  "*.tsx": "${capture}.js, ${capture}.jsx",
  "*.js": "${capture}.js.map, ${capture}.min.js, ${capture}.d.ts",
  "*.jsx": "${capture}.js",
  "*.css": "${capture}.css.map, ${capture}.min.css",
  "*.scss": "${capture}.css",
  "*.java": "${capture}.class",
  "package.json": "package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb, bun.lock, .npmrc, .yarnrc, .nvmrc",
  "tsconfig.json": "tsconfig.*.json",
  "vite.config.*": "vitest.config.*",
  "requirements.txt": "requirements-*.txt",
  "pyproject.toml": "poetry.lock, setup.py, setup.cfg, Pipfile, Pipfile.lock",
  "composer.json": "composer.lock",
  "Dockerfile": "docker-compose*.yml, docker-compose*.yaml, .dockerignore",
  ".gitignore": ".gitattributes, .gitmodules",
  "README.md": "LICENSE*, CHANGELOG*, CONTRIBUTING*, CODE_OF_CONDUCT*",
};

const globToRegex = (glob: string) => new RegExp(`^${glob.trim().replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/**
 * Which sibling files nest under which (VS Code's explorer.fileNesting): a key
 * names the parent ("*.ts" captures the part the * matched), its value the
 * children ("${capture}.js, *.d.ts"). A file is nested under one parent only,
 * and a nested file never has children of its own.
 */
export function nestFiles(files: DirEntry[], rules: Record<string, string>): Map<string, DirEntry[]> {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const out = new Map<string, DirEntry[]>();
  const taken = new Set<string>();
  for (const parent of files) {
    for (const [key, value] of Object.entries(rules)) {
      const keyRe = globToRegex(key);
      if (!keyRe.test(parent.name)) continue;
      const star = key.indexOf("*");
      const capture = star < 0 ? "" : parent.name.slice(star, parent.name.length - (key.length - star - 1));
      const base = parent.name.replace(/\.[^.]*$/, "");
      const kids: DirEntry[] = [];
      for (const pattern of value.split(",").map((p) => p.trim()).filter(Boolean)) {
        const p = pattern.replace(/\$\{capture\}/g, capture).replace(/\$\{basename\}/g, base);
        const re = globToRegex(p);
        for (const f of files) {
          const lower = f.name.toLowerCase();
          if (f === parent || taken.has(lower) || !re.test(f.name) || byName.get(lower) !== f) continue;
          kids.push(f);
        }
      }
      if (kids.length) {
        for (const k of kids) taken.add(k.name.toLowerCase());
        out.set(parent.path, [...(out.get(parent.path) ?? []), ...kids]);
      }
    }
  }
  // A file nested under another can't be a parent too.
  for (const parent of [...out.keys()]) if (taken.has(parent.split("/").pop()!.toLowerCase())) out.delete(parent);
  return out;
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
    const children = visibleChildren(dirs, path, opts.exclude) ?? [];
    const nests = opts.nesting ? nestFiles(children.filter((e) => e.kind === "file"), opts.nesting) : null;
    const nestedNames = new Set([...(nests?.values() ?? [])].flat().map((e) => e.path));
    for (const entry of children) {
      if (entry.kind !== "dir") {
        if (nestedNames.has(entry.path)) continue;
        const kids = nests?.get(entry.path);
        rows.push(kids ? { entry, depth, nested: kids } : { entry, depth });
        if (kids && expanded[entry.path]) for (const k of kids) rows.push({ entry: k, depth: depth + 1 });
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

/**
 * Find in the Explorer: every loaded file and folder whose name contains the
 * query (as VS Code's tree filter), with the folders above it, folders shown
 * open. Only folders TMCode has read (opened at least once) are searched.
 */
export function findRows(dirs: Record<string, DirEntry[]>, exclude: PathMatcher, query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const keep = new Map<string, [number, number] | undefined>();
  const walk = (path: string) => {
    for (const e of visibleChildren(dirs, path, exclude) ?? []) {
      const at = e.name.toLowerCase().indexOf(q);
      if (at >= 0) {
        keep.set(e.path, [at, at + q.length]);
        // Its folders stay too (without a match of their own unless they have one).
        let p = path;
        while (p && !keep.has(p)) {
          keep.set(p, undefined);
          p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        }
      }
      if (e.kind === "dir") walk(e.path);
    }
  };
  walk("");
  const rows: Row[] = [];
  const emit = (path: string, depth: number) => {
    for (const e of visibleChildren(dirs, path, exclude) ?? []) {
      if (!keep.has(e.path)) continue;
      const match = keep.get(e.path);
      rows.push(match ? { entry: e, depth, match } : { entry: e, depth });
      if (e.kind === "dir") emit(e.path, depth + 1);
    }
  };
  emit("", 0);
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
