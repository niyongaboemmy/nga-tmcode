import type { GitEntry, GitStatus } from "../platform/types";
import { dirname } from "../util/paths";

/**
 * Git status → what the Source Control view, the explorer and the status bar
 * show, with VS Code's letters, colours and tooltips. Pure, unit-tested.
 */

export type ResourceGroup = "merge" | "index" | "workingTree" | "untracked";

/** Colour class, after VS Code's gitDecoration.*ResourceForeground keys. */
export type DecorationColor = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict" | "ignored";

export interface Resource {
  path: string;
  origPath?: string;
  group: ResourceGroup;
  /** M, A, D, R, C, U (untracked), T, ! (conflict) */
  letter: string;
  color: DecorationColor;
  tooltip: string;
  /** The working-tree file is gone (diff shows the old content only). */
  deleted: boolean;
  /** No base version: opening shows the file, not a diff. */
  untracked: boolean;
}

export interface Groups {
  merge: Resource[];
  staged: Resource[];
  changes: Resource[];
}

const LETTER_INFO: Record<string, { color: DecorationColor; index: string; tree: string }> = {
  M: { color: "modified", index: "Index Modified", tree: "Modified" },
  T: { color: "modified", index: "Index Type Changed", tree: "Type Changed" },
  A: { color: "added", index: "Index Added", tree: "Intent to Add" },
  D: { color: "deleted", index: "Index Deleted", tree: "Deleted" },
  R: { color: "renamed", index: "Index Renamed", tree: "Renamed" },
  C: { color: "renamed", index: "Index Copied", tree: "Copied" },
};

const CONFLICT_TOOLTIP: Record<string, string> = {
  DD: "Conflict: Both Deleted",
  AU: "Conflict: Added By Us",
  UD: "Conflict: Deleted By Them",
  UA: "Conflict: Added By Them",
  DU: "Conflict: Deleted By Us",
  AA: "Conflict: Both Added",
  UU: "Conflict: Both Modified",
};

export function groupsOf(status: GitStatus | null): Groups {
  const g: Groups = { merge: [], staged: [], changes: [] };
  if (!status) return g;
  for (const e of status.entries) {
    if (e.kind === "ignored") continue;
    if (e.kind === "unmerged") {
      const xy = e.x + e.y;
      g.merge.push({
        path: e.path,
        group: "merge",
        letter: "!",
        color: "conflict",
        tooltip: CONFLICT_TOOLTIP[xy] ?? "Conflict",
        deleted: xy === "DD" || xy === "UD" || xy === "DU",
        untracked: false,
      });
      continue;
    }
    if (e.kind === "untracked") {
      g.changes.push({ path: e.path, group: "untracked", letter: "U", color: "untracked", tooltip: "Untracked", deleted: false, untracked: true });
      continue;
    }
    if (e.x !== ".") {
      const info = LETTER_INFO[e.x] ?? LETTER_INFO.M;
      g.staged.push({
        path: e.path,
        origPath: e.orig_path,
        group: "index",
        letter: e.x === "T" ? "T" : e.x,
        color: info.color,
        tooltip: info.index,
        deleted: e.x === "D",
        untracked: false,
      });
    }
    if (e.y !== ".") {
      const info = LETTER_INFO[e.y] ?? LETTER_INFO.M;
      g.changes.push({
        path: e.path,
        // An "intent to add" (git add -N) file has no index content yet.
        group: "workingTree",
        letter: e.y,
        color: info.color,
        tooltip: info.tree,
        deleted: e.y === "D",
        untracked: e.y === "A",
      });
    }
  }
  const byPath = (a: Resource, b: Resource) => a.path.localeCompare(b.path);
  g.merge.sort(byPath);
  g.staged.sort(byPath);
  g.changes.sort(byPath);
  return g;
}

/** The activity-bar badge: every change in every group, as VS Code counts it. */
export function changeCount(status: GitStatus | null): number {
  const g = groupsOf(status);
  return g.merge.length + g.staged.length + g.changes.length;
}

export interface Decoration {
  letter: string;
  color: DecorationColor;
  tooltip: string;
}

/** Strongest first, for a file in several groups and for folders. */
const PRIORITY: DecorationColor[] = ["conflict", "deleted", "modified", "renamed", "added", "untracked", "ignored"];
const rank = (c: DecorationColor) => PRIORITY.indexOf(c);

/**
 * Explorer decorations by workspace path. Files get a letter and colour (the
 * working-tree state wins over the staged one, like VS Code); every folder
 * above a change gets the strongest colour below it, without a letter.
 */
export function decorationsOf(status: GitStatus | null): Record<string, Decoration> {
  const out: Record<string, Decoration> = {};
  if (!status) return out;
  const g = groupsOf(status);
  const put = (r: Resource) => {
    const cur = out[r.path];
    if (!cur || rank(r.color) < rank(cur.color)) out[r.path] = { letter: r.letter, color: r.color, tooltip: r.tooltip };
  };
  // Staged first, then the working tree overrides with what's on disk now.
  g.staged.forEach(put);
  for (const r of [...g.changes, ...g.merge]) out[r.path] = { letter: r.letter, color: r.color, tooltip: r.tooltip };
  for (const [path, d] of Object.entries({ ...out })) {
    if (d.color === "deleted") continue; // deleted files aren't in the tree; folders still get the colour
    let dir = dirname(path);
    while (dir) {
      const cur = out[dir];
      if (!cur || (cur.letter === "" && rank(d.color) < rank(cur.color))) out[dir] = { letter: "", color: d.color, tooltip: "Contains changes" };
      dir = dirname(dir);
    }
  }
  return out;
}

/** True when `path` or a folder above it is ignored. */
export function isIgnored(path: string, ignored: Record<string, true>): boolean {
  let p = path;
  while (p) {
    if (ignored[p]) return true;
    p = dirname(p);
  }
  return false;
}

/** Status bar text: "main*", or the short commit when detached ("8f3a2b1"). */
export function branchLabel(status: GitStatus | null): string {
  if (!status) return "";
  const name = status.branch ?? (status.oid ? status.oid.slice(0, 8) : "HEAD");
  const dirty = status.entries.some((e) => e.kind !== "ignored" && (e.kind === "untracked" || e.y !== "."));
  const staged = status.entries.some((e) => e.kind !== "untracked" && e.kind !== "ignored" && e.x !== ".");
  const conflicts = status.entries.some((e) => e.kind === "unmerged");
  return `${name}${dirty ? "*" : ""}${staged ? "+" : ""}${conflicts ? "!" : ""}`;
}

/** "Commit" button's job when there is nothing to commit, VS Code style. */
export function primaryAction(status: GitStatus | null): "commit" | "sync" | "publish" {
  if (!status) return "commit";
  if (changeCount(status) > 0) return "commit";
  if (status.branch && !status.upstream && status.remotes.length > 0 && status.oid) return "publish";
  if (status.upstream && (status.ahead > 0 || status.behind > 0)) return "sync";
  return "commit";
}

/** Branch names git accepts (mirrors git.rs `check_ref_name`). */
export function validateBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Please provide a branch name";
  const bad =
    n.startsWith("-") ||
    n.startsWith("/") ||
    n.endsWith("/") ||
    n.endsWith(".") ||
    n.endsWith(".lock") ||
    n.includes("..") ||
    n.includes("@{") ||
    n.includes("//") ||
    n === "@" ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(n);
  return bad ? `'${n}' is not a valid branch name` : null;
}

/** Splits entries into what discard must restore vs delete. */
export function discardPlan(resources: Resource[]): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const r of resources) (r.untracked ? untracked : tracked).push(r.path);
  return { tracked, untracked };
}

export type { GitEntry };
