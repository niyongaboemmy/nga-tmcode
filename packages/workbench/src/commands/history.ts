/**
 * Pure editor-history structures (unit tested): most-recently-used lists,
 * the reopen-closed stack and the Back/Forward navigation stack.
 */

/** Moves `id` to the front of an MRU list (dropping duplicates, capped). */
export function touchMru<T>(list: T[], id: T, cap = 50): T[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, cap);
}

/** The MRU order restricted to what is still open; editors never activated go last, in tab order. */
export function mruOrder(mru: string[], open: string[]): string[] {
  const known = mru.filter((id) => open.includes(id));
  return [...known, ...open.filter((id) => !known.includes(id))];
}

export interface Location {
  path: string;
  line: number;
  column: number;
  group?: number;
}

/** Lines apart before a cursor move counts as a new place to go back to (VS Code uses 10). */
export const NEAR_LINES = 10;

/**
 * Back/Forward history: a list with a cursor. Moving the cursor nearby only
 * updates the current entry; a jump (another file, or ≥10 lines away) adds
 * one and drops anything "forward" of it.
 */
export class NavigationStack {
  entries: Location[] = [];
  index = -1;
  constructor(private cap = 50) {}

  record(loc: Location) {
    const cur = this.entries[this.index];
    if (cur && cur.path === loc.path && Math.abs(cur.line - loc.line) < NEAR_LINES) {
      this.entries[this.index] = loc;
      return;
    }
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(loc);
    if (this.entries.length > this.cap) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  canBack() {
    return this.index > 0;
  }
  canForward() {
    return this.index < this.entries.length - 1;
  }
  back(): Location | null {
    if (!this.canBack()) return null;
    return this.entries[--this.index];
  }
  forward(): Location | null {
    if (!this.canForward()) return null;
    return this.entries[++this.index];
  }
  /** Drops every entry of a path (deleted file) or all of them. */
  clear(path?: string) {
    if (path === undefined) {
      this.entries = [];
      this.index = -1;
      return;
    }
    const keep = this.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.path !== path);
    const before = keep.filter(({ i }) => i <= this.index).length;
    this.entries = keep.map(({ e }) => e);
    this.index = Math.min(this.entries.length - 1, Math.max(before - 1, this.entries.length ? 0 : -1));
  }
}

/** Parses a Quick Open query: "main.py:12", "main.py:12:5", "main.py(12,5)" → name + line/column. */
export function parseLineSuffix(query: string): { query: string; line?: number; column?: number } {
  const m = /^(.*?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))\s*$/.exec(query);
  if (!m) {
    // "main.py:" while typing: search the name, no line yet.
    const bare = /^(.*?):\s*$/.exec(query);
    return { query: bare ? bare[1] : query };
  }
  const line = Number(m[2] ?? m[4]);
  const col = m[3] ?? m[5];
  return { query: m[1], line: line > 0 ? line : 1, column: col ? Math.max(1, Number(col)) : undefined };
}
