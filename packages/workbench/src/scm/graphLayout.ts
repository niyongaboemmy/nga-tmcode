import type { GraphCommit } from "../platform/types";

/**
 * Lanes of a commit graph (Source Control › Graph), as git log --graph draws
 * them: each commit sits in a lane; lanes carry the parents still to come.
 * Pure: each row says which lanes pass through, and where its lines go.
 */

export interface GraphRow {
  commit: GraphCommit;
  /** The commit's lane. */
  col: number;
  /** Lanes coming in from the row above (hash expected next in that lane, or null). */
  before: (string | null)[];
  /** Lanes going on to the row below. */
  after: (string | null)[];
  /** The lanes its parents continue in (first parent first). */
  parentCols: number[];
}

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const before = [...lanes];
    let col = lanes.indexOf(commit.hash);
    if (col < 0) {
      col = lanes.indexOf(null);
      if (col < 0) col = lanes.push(null) - 1;
    }
    // Other lanes waiting for this same commit end here (branches that meet).
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === commit.hash) lanes[i] = null;
    const parentCols: number[] = [];
    commit.parents.forEach((p, i) => {
      if (i === 0) {
        lanes[col] = p;
        parentCols.push(col);
        return;
      }
      const existing = lanes.indexOf(p);
      if (existing >= 0) parentCols.push(existing);
      else {
        let free = lanes.indexOf(null);
        if (free < 0) free = lanes.push(null) - 1;
        lanes[free] = p;
        parentCols.push(free);
      }
    });
    if (!commit.parents.length) lanes[col] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit, col, before, after: [...lanes], parentCols });
  }
  return rows;
}

/** VS Code's graph colours, by lane. */
export const LANE_COLORS = ["#FFB000", "#DC267F", "#994F00", "#40B0A6", "#B66DFF", "#1A85FF", "#E66100", "#5D3A9B"];
