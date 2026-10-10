/**
 * Merge conflicts in a file, as git writes them:
 *
 *   <<<<<<< HEAD            (current change: yours)
 *   …
 *   ||||||| base            (optional, merge.conflictStyle=diff3)
 *   …
 *   =======
 *   …
 *   >>>>>>> feature/login   (incoming change: theirs)
 *
 * Pure functions: parsing and resolving one conflict, for VS Code's
 * "Accept Current Change | Accept Incoming Change | Accept Both Changes |
 * Compare Changes" CodeLens (scm/extras.ts).
 */

export interface Conflict {
  /** 1-based line of `<<<<<<<`. */
  start: number;
  /** 1-based line of `|||||||` (diff3), if any. */
  base: number | null;
  /** 1-based line of `=======`. */
  middle: number;
  /** 1-based line of `>>>>>>>`. */
  end: number;
  /** Text after the markers: "HEAD", "feature/login". */
  currentLabel: string;
  incomingLabel: string;
  current: string[];
  incoming: string[];
}

export type ConflictChoice = "current" | "incoming" | "both";

const START = /^<{7}(?:\s(.*))?$/;
const BASE = /^\|{7}(?:\s.*)?$/;
const MIDDLE = /^={7}$/;
const END = /^>{7}(?:\s(.*))?$/;

/** Every complete conflict block; markers without their partners are ignored. */
export function parseConflicts(text: string): Conflict[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Conflict[] = [];
  let i = 0;
  while (i < lines.length) {
    const s = START.exec(lines[i]);
    if (!s) {
      i++;
      continue;
    }
    let base: number | null = null;
    let middle = -1;
    let end = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (START.test(lines[j])) break; // a new block before this one closed: this one is broken
      if (middle < 0 && base === null && BASE.test(lines[j])) base = j;
      else if (middle < 0 && MIDDLE.test(lines[j])) middle = j;
      else if (middle >= 0 && END.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (middle < 0 || end < 0) {
      i = j;
      continue;
    }
    out.push({
      start: i + 1,
      base: base === null ? null : base + 1,
      middle: middle + 1,
      end: end + 1,
      currentLabel: (s[1] ?? "").trim(),
      incomingLabel: (END.exec(lines[end])?.[1] ?? "").trim(),
      current: lines.slice(i + 1, base ?? middle),
      incoming: lines.slice(middle + 1, end),
    });
    i = end + 1;
  }
  return out;
}

/** The lines that replace a conflict block for a choice. */
export function resolution(c: Conflict, choice: ConflictChoice): string[] {
  if (choice === "current") return c.current;
  if (choice === "incoming") return c.incoming;
  return [...c.current, ...c.incoming];
}

/** The whole text with one conflict resolved (the file's line ending is kept). */
export function resolveConflict(text: string, c: Conflict, choice: ConflictChoice): string {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\r|\n/);
  lines.splice(c.start - 1, c.end - c.start + 1, ...resolution(c, choice));
  return lines.join(eol);
}

/** Every conflict in the text resolved the same way (Accept All Current / Incoming / Both). */
export function resolveAll(text: string, choice: ConflictChoice): string {
  let out = text;
  for (const c of parseConflicts(text).reverse()) out = resolveConflict(out, c, choice);
  return out;
}

export function hasConflictMarkers(text: string) {
  return /^<{7}(\s|$)/m.test(text) && /^={7}$/m.test(text) && /^>{7}(\s|$)/m.test(text);
}
