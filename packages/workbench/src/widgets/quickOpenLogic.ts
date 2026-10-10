import { fuzzyMatch } from "../util/fuzzy";
import { basename, dirname } from "../util/paths";

/** Pure Quick Open helpers (unit tested): prefix modes and path matching. */

export type QuickMode = "files" | "commands" | "line" | "symbols" | "workspaceSymbols" | "help";

/** VS Code's prefixes: ">" commands, ":" line, "@" symbols in the file, "#" workspace symbols, "?" help. */
export function modeOfValue(value: string, opts: { workspaceSymbols: boolean }): { mode: QuickMode; query: string } {
  if (value.startsWith(">")) return { mode: "commands", query: value.slice(1).trim() };
  if (value.startsWith(":")) return { mode: "line", query: value.slice(1).trim() };
  if (value.startsWith("@")) return { mode: "symbols", query: value.slice(1).trim() };
  if (value.startsWith("#") && opts.workspaceSymbols) return { mode: "workspaceSymbols", query: value.slice(1).trim() };
  if (value.startsWith("?")) return { mode: "help", query: value.slice(1).trim() };
  return { mode: "files", query: value.trim() };
}

export interface PathMatch {
  score: number;
  /** Highlights in the file name. */
  labelIndices: number[];
  /** Highlights in the folder part. */
  descIndices: number[];
}

/**
 * Matches a query against a workspace path: the file name first (a hit there
 * ranks higher), then the whole path, so "srcut" finds src/utils.ts.
 */
export function matchPath(query: string, path: string): PathMatch | null {
  const q = query.replace(/\\/g, "/").trim();
  if (!q) return { score: 0, labelIndices: [], descIndices: [] };
  const name = basename(path);
  const dir = dirname(path);
  if (!q.includes("/")) {
    const m = fuzzyMatch(q, name);
    if (m) return { score: m.score + 20, labelIndices: m.indices, descIndices: [] };
  }
  const pm = fuzzyMatch(q, path);
  if (!pm) return null;
  const offset = dir ? dir.length + 1 : 0;
  return {
    score: pm.score,
    labelIndices: pm.indices.filter((i) => i >= offset).map((i) => i - offset),
    descIndices: pm.indices.filter((i) => i < dir.length),
  };
}

/** Ranks files for a query; recently opened ones win ties and come first when the query is empty. */
export function rankFiles(query: string, files: string[], recent: string[]): { path: string; match: PathMatch; recent: boolean }[] {
  const recentSet = new Set(recent);
  if (!query.trim()) {
    const fileSet = new Set(files);
    const r = recent.filter((p) => fileSet.has(p));
    const rest = files.filter((p) => !recentSet.has(p));
    return [...r.map((path) => ({ path, match: { score: 0, labelIndices: [], descIndices: [] }, recent: true })), ...rest.map((path) => ({ path, match: { score: 0, labelIndices: [], descIndices: [] }, recent: false }))];
  }
  return files
    .map((path) => {
      const match = matchPath(query, path);
      return match ? { path, match: { ...match, score: match.score + (recentSet.has(path) ? 2 : 0) }, recent: recentSet.has(path) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.match.score - a.match.score || a.path.length - b.path.length);
}

/** Recently opened files per folder, kept across restarts. */
const RECENT_PREFIX = "tmcode:recent-files:";
export function loadRecentFiles(root: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_PREFIX + root) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}
export function saveRecentFiles(root: string, files: string[]) {
  try {
    localStorage.setItem(RECENT_PREFIX + root, JSON.stringify(files.slice(0, 50)));
  } catch {
    /* private window: recents stay in memory */
  }
}
