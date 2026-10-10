/**
 * One change ("hunk") between a file's staged version and the editor's text:
 * VS Code's Stage Change / Revert Change from the gutter and the diff editor.
 * Pure functions over text; the line diff is scm/lineDiff.ts.
 */
import { diffLines, splitLines, type Hunk } from "./lineDiff";

export type { Hunk };

export function hunksBetween(base: string, current: string): Hunk[] {
  return diffLines(splitLines(base), splitLines(current));
}

/**
 * The hunk at a 1-based line of the current text. A deletion has no lines of
 * its own: it belongs to the line it sits under (or above, at the top).
 */
export function hunkAtLine(hunks: Hunk[], line: number): Hunk | null {
  const at = line - 1;
  return (
    hunks.find((h) => (h.modLength > 0 ? at >= h.modStart && at < h.modStart + h.modLength : at === h.modStart - 1 || at === h.modStart || (h.modStart === 0 && at === 0))) ?? null
  );
}

const eolOf = (text: string) => (/\r\n/.test(text) ? "\r\n" : "\n");

/** The staged text with this one change applied (what Stage Change writes to the index). */
export function stageHunk(base: string, current: string, h: Hunk): string {
  const b = splitLines(base);
  const c = splitLines(current);
  b.splice(h.origStart, h.origLength, ...c.slice(h.modStart, h.modStart + h.modLength));
  return b.join(eolOf(base || current));
}

/** The current text with this one change undone (what Revert Change puts in the editor). */
export function revertHunk(base: string, current: string, h: Hunk): string {
  const b = splitLines(base);
  const c = splitLines(current);
  c.splice(h.modStart, h.modLength, ...b.slice(h.origStart, h.origStart + h.origLength));
  return c.join(eolOf(current || base));
}

/** "Stage lines 3–5" for menus. */
export function describeHunk(h: Hunk): string {
  if (h.modLength === 0) return `${h.origLength} deleted line${h.origLength === 1 ? "" : "s"}`;
  const a = h.modStart + 1;
  const b = h.modStart + h.modLength;
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}
