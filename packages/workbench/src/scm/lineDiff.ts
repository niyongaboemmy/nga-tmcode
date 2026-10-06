/**
 * A small line diff (Myers' O(ND) algorithm) for the editor gutter's
 * added / modified / deleted marks, like VS Code's quick diff.
 */

export interface Hunk {
  /** 0-based start and length in the original lines. */
  origStart: number;
  origLength: number;
  /** 0-based start and length in the modified lines. */
  modStart: number;
  modLength: number;
}

export type GutterKind = "added" | "modified" | "deleted";

export interface GutterMark {
  kind: GutterKind;
  /** 1-based, inclusive. For "deleted": the line the deletion sits above (0 = top of file). */
  startLine: number;
  endLine: number;
}

/** Beyond this edit distance the middle of the file is reported as one change. */
const MAX_D = 1500;

/** Hunks that turn `a` into `b`. */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  // Common prefix and suffix are cheap and cover most edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  if (start === endA || start === endB) return [{ origStart: start, origLength: endA - start, modStart: start, modLength: endB - start }];
  const hunks = myers(a.slice(start, endA), b.slice(start, endB));
  if (!hunks) return [{ origStart: start, origLength: endA - start, modStart: start, modLength: endB - start }];
  return hunks.map((h) => ({ ...h, origStart: h.origStart + start, modStart: h.modStart + start }));
}

/** Myers with a trace for backtracking; null when the edit distance exceeds MAX_D. */
function myers(a: readonly string[], b: readonly string[]): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_D);
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) {
      trace.push(v.slice());
      break;
    }
  }
  if (found < 0) return null;

  // Backtrack into a list of edit operations, then group them into hunks.
  const ops: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("+");
      y--;
    } else {
      ops.push("-");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  ops.reverse();

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op === "=") {
      if (cur) hunks.push(cur);
      cur = null;
      i++;
      j++;
      continue;
    }
    cur ??= { origStart: i, origLength: 0, modStart: j, modLength: 0 };
    if (op === "-") {
      cur.origLength++;
      i++;
    } else {
      cur.modLength++;
      j++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** Gutter marks on the modified side (1-based lines), as VS Code draws them. */
export function gutterMarks(original: readonly string[], modified: readonly string[]): GutterMark[] {
  return diffLines(original, modified).map((h) => {
    if (h.origLength === 0) return { kind: "added", startLine: h.modStart + 1, endLine: h.modStart + h.modLength };
    if (h.modLength === 0) return { kind: "deleted", startLine: h.modStart, endLine: h.modStart };
    return { kind: "modified", startLine: h.modStart + 1, endLine: h.modStart + h.modLength };
  });
}

/** Splits text into lines, ignoring the EOL style (CRLF vs LF never counts as a change). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}
