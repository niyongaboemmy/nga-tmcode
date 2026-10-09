import { inExam, useExam } from "../exam/state";
import { confirmCloseDirty, log, showDialog, useWorkbench } from "./store";

/**
 * Close / quit guard. The desktop app calls `beforeQuit()` when the window's
 * close button, ⌘Q or Alt+F4 asks to quit, and keeps TMCode open on false.
 * Modules add their own checks with `registerQuitGuard` (the exam's unsent
 * changes); unsaved files are asked about last, as in VS Code.
 */

/** Resolves false to keep TMCode open. A guard that throws never blocks quitting. */
export type QuitGuard = () => Promise<boolean> | boolean;

const guards = new Set<QuitGuard>();

export function registerQuitGuard(guard: QuitGuard) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

let asking: Promise<boolean> | null = null;

/** True when TMCode may close now. A second close request while asking gets the same answer. */
export function beforeQuit(): Promise<boolean> {
  asking ??= runGuards().finally(() => {
    asking = null;
  });
  return asking;
}

async function runGuards(): Promise<boolean> {
  for (const guard of [...guards, unsavedFiles]) {
    try {
      if (!(await guard())) return false;
    } catch (e) {
      log("Workbench", `Quit check failed: ${String((e as Error)?.message ?? e)}`, "warn");
    }
  }
  return true;
}

/** Save All / Don't Save / Cancel for unsaved files. */
async function unsavedFiles(): Promise<boolean> {
  const dirty = Object.keys(useWorkbench.getState().dirty);
  if (!dirty.length) return true;
  // A failed save throws: stay open so the student sees the error.
  const choice = await confirmCloseDirty(dirty).catch(() => "cancel" as const);
  return choice !== "cancel";
}

/** In an exam: changes still on their way to Task Mentor. */
registerQuitGuard(async () => {
  if (!inExam()) return true;
  const { pending, queued } = useExam.getState().sync;
  const unsent = pending + queued;
  if (!unsent) return true;
  const choice = await showDialog({
    message: unsent === 1 ? "1 change hasn't reached Task Mentor yet." : `${unsent} changes haven't reached Task Mentor yet.`,
    detail: "Keep TMCode open until they are sent. If you quit now, your teacher may not get your latest work.",
    severity: "warning",
    buttons: [
      { id: "keep", label: "Keep TMCode Open", primary: true },
      { id: "quit", label: "Quit Anyway", destructive: true },
    ],
    cancelId: "keep",
  });
  return choice === "quit";
});
