import { deleteEntryUnasked, getPlatform, moveEntry, notify } from "../../state/store";
import { basename, dirname } from "../../util/paths";

/**
 * Undo for Explorer file operations, as VS Code's ⌘Z / Ctrl+Z does with the Explorer focused:
 * a rename or move goes back, and what a paste, Duplicate, New File / New Folder or a drop from
 * Finder made goes to the Trash. Deletes are not here: Local History's Undo restores those.
 * An undo that no longer fits (the file was moved or renamed since) says so and does nothing.
 */

export interface FileOp {
  /** "Rename main.py", "Paste 3 items"… */
  label: string;
  undo(): Promise<void>;
}

const MAX = 30;
let stack: FileOp[] = [];

export function recordFileOp(op: FileOp) {
  stack.push(op);
  if (stack.length > MAX) stack = stack.slice(-MAX);
}

/** A rename or move (from → to) whose undo moves it back. */
export function recordMove(label: string, moves: { from: string; to: string }[]) {
  if (!moves.length) return;
  recordFileOp({
    label,
    undo: async () => {
      for (const { from, to } of [...moves].reverse()) {
        if (!(await exists(to))) throw new Error(`'${basename(to)}' isn't there any more.`);
        if (await exists(from)) throw new Error(`'${basename(from)}' exists again.`);
        await moveEntry(to, from);
      }
    },
  });
}

/** Entries the Explorer created (paste, Duplicate, New File, a drop): undo removes them. */
export function recordCreated(label: string, paths: string[]) {
  if (!paths.length) return;
  recordFileOp({
    label,
    undo: async () => {
      for (const path of [...paths].reverse()) {
        if (!(await exists(path))) continue;
        await deleteEntryUnasked(path);
      }
    },
  });
}

export const canUndoFileOp = () => stack.length > 0;

export async function undoFileOp() {
  const op = stack.pop();
  if (!op) {
    notify("info", "Nothing to undo in the Explorer.", undefined, { kind: "hint" });
    return false;
  }
  try {
    await op.undo();
    notify("info", `Undone: ${op.label}.`, undefined, { kind: "result" });
    return true;
  } catch (e) {
    notify("warning", `Can't undo ${op.label}: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
}

async function exists(path: string) {
  try {
    return (await getPlatform().fs.readDir(dirname(path))).some((e) => e.path === path);
  } catch {
    return false;
  }
}

/** For tests. */
export function clearFileOps() {
  stack = [];
}
