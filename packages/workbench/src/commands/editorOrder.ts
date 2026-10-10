/**
 * Which editors the editor commands act on (Open Next Editor, Move Editor
 * Left, Close Others…), shared by the tab menu and the commands. Pure, so the
 * rules are unit-tested: pinned tabs survive Close Others / Close to the
 * Right and stay among the pinned when moved, as in VS Code.
 */

export interface TabLike {
  id: string;
  sticky?: boolean;
  /** The document has unsaved changes. */
  dirty?: boolean;
}

export interface GroupLike<T extends TabLike = TabLike> {
  id: number;
  editors: T[];
  activeId: string | null;
}

/** Close Other Editors in Group: everything but `id` and the pinned tabs. */
export function otherEditorIds(editors: TabLike[], id: string): string[] {
  return editors.filter((e) => e.id !== id && !e.sticky).map((e) => e.id);
}

/** Close Editors to the Right in Group (pinned tabs stay). */
export function editorIdsToTheRight(editors: TabLike[], id: string): string[] {
  const at = editors.findIndex((e) => e.id === id);
  if (at < 0) return [];
  return editors.slice(at + 1).filter((e) => !e.sticky).map((e) => e.id);
}

/** Close Saved Editors in Group: the ones without unsaved changes. */
export function savedEditorIds(editors: TabLike[]): string[] {
  return editors.filter((e) => !e.dirty).map((e) => e.id);
}

/**
 * Open Next / Previous Editor: the neighbour in the active group; past the
 * last (first) editor, the first (last) editor of the next (previous) group,
 * wrapping around, as VS Code does. `groups` are in reading order.
 */
export function adjacentEditor(groups: GroupLike[], activeGroup: number, step: 1 | -1): { group: number; id: string } | null {
  const gi = groups.findIndex((g) => g.id === activeGroup);
  if (gi < 0) return null;
  const g = groups[gi];
  const at = g.editors.findIndex((e) => e.id === g.activeId);
  const next = at + step;
  if (at >= 0 && next >= 0 && next < g.editors.length) return { group: g.id, id: g.editors[next].id };
  // Off the end of this group: the next group with editors (wrapping, possibly back to this one).
  for (let k = 1; k <= groups.length; k++) {
    const other = groups[(((gi + step * k) % groups.length) + groups.length) % groups.length];
    if (!other.editors.length) continue;
    const e = step > 0 ? other.editors[0] : other.editors[other.editors.length - 1];
    return e.id === g.activeId && other.id === g.id ? null : { group: other.id, id: e.id };
  }
  return null;
}

/**
 * Move Editor Left / Right in its group: one place, never across the line
 * between pinned and unpinned tabs. Null when it can't move.
 */
export function moveWithinGroup<T extends TabLike>(editors: T[], id: string, step: 1 | -1): T[] | null {
  const at = editors.findIndex((e) => e.id === id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= editors.length) return null;
  if (!!editors[to].sticky !== !!editors[at].sticky) return null;
  const out = [...editors];
  [out[at], out[to]] = [out[to], out[at]];
  return out;
}

/** First lines of each run of changed lines (quick diff marks), in order. */
export function changeStarts(lines: number[]): number[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  return sorted.filter((l, i) => i === 0 || sorted[i - 1] !== l - 1);
}

/** Go to Next / Previous Change: the first change start after (before) `line`, wrapping around. */
export function nextChangeLine(starts: number[], line: number, step: 1 | -1): number | null {
  if (!starts.length) return null;
  if (step > 0) return starts.find((s) => s > line) ?? starts[0];
  const before = starts.filter((s) => s < line);
  return before.length ? before[before.length - 1] : starts[starts.length - 1];
}

/** The group before / after `group` in reading order (no wrap), for Move Editor into Next / Previous Group. */
export function siblingGroup(order: number[], group: number, step: 1 | -1): number | null {
  const at = order.indexOf(group);
  if (at < 0) return null;
  return order[at + step] ?? null;
}
