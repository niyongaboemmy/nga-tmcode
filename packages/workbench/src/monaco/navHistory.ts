/**
 * Editor navigation history (VS Code's Go Back / Go Forward): where the
 * cursor was before a jump (Go to Definition, a reference, a far click).
 * Pure logic, no Monaco, so it can be unit tested.
 */

export interface NavLocation {
  path: string;
  line: number;
  column: number;
}

/** A move of at least this many lines inside one file counts as a jump (VS Code uses 10). */
export const JUMP_LINES = 10;
const LIMIT = 50;

export class NavHistory {
  private back: NavLocation[] = [];
  private forward: NavLocation[] = [];

  /** Remembers `from`, the place being left. A new jump clears Forward. */
  record(from: NavLocation | null) {
    if (!from) return;
    const top = this.back[this.back.length - 1];
    if (top && top.path === from.path && Math.abs(top.line - from.line) < JUMP_LINES) this.back.pop();
    this.back.push(from);
    if (this.back.length > LIMIT) this.back.shift();
    this.forward.length = 0;
  }

  /** The place to go back to; `current` becomes the Forward target. */
  goBack(current: NavLocation | null): NavLocation | null {
    const target = this.back.pop() ?? null;
    if (target && current) this.forward.push(current);
    return target;
  }

  goForward(current: NavLocation | null): NavLocation | null {
    const target = this.forward.pop() ?? null;
    if (target && current) this.back.push(current);
    return target;
  }

  canGoBack() {
    return this.back.length > 0;
  }

  canGoForward() {
    return this.forward.length > 0;
  }

  /** A file was renamed or deleted: rewrite or drop its entries. */
  rename(from: string, to: string | null) {
    const fix = (list: NavLocation[]) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i].path;
        if (p !== from && !p.startsWith(`${from}/`)) continue;
        if (to === null) list.splice(i, 1);
        else list[i] = { ...list[i], path: to + p.slice(from.length) };
      }
    };
    fix(this.back);
    fix(this.forward);
  }

  clear() {
    this.back.length = 0;
    this.forward.length = 0;
  }
}

/** Whether a cursor move inside one file is far enough to be remembered. */
export function isJump(from: { line: number } | null, to: { line: number }) {
  return !!from && Math.abs(from.line - to.line) >= JUMP_LINES;
}
