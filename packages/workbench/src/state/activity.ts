import { create } from "zustand";

/**
 * Work in flight (a Task Mentor request, a save, opening a submission…), so
 * the workbench shows that it is busy the instant something starts, not after
 * the first slow step (scanning files, the first round trip) has finished.
 * The progress line under the title bar and the status bar item read this.
 */

interface Running {
  id: number;
  label: string;
  startedAt: number;
}

interface ActivityState {
  running: Running[];
}

export const useActivity = create<ActivityState>(() => ({ running: [] }));
let seq = 0;

/** Marks work as started; call the returned function when it ends (idempotent). */
export function beginActivity(label: string): () => void {
  const id = ++seq;
  useActivity.setState((s) => ({ running: [...s.running, { id, label, startedAt: Date.now() }] }));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    useActivity.setState((s) => ({ running: s.running.filter((r) => r.id !== id) }));
  };
}

/** Runs `work` as an activity: shown at once, cleared when it settles (also on errors). */
export async function track<T>(label: string, work: () => Promise<T>): Promise<T> {
  const end = beginActivity(label);
  try {
    return await work();
  } finally {
    end();
  }
}

/** The label to show: the oldest named activity still running (requests are "Task Mentor…"). */
export function currentActivity(running: Running[]): string | null {
  if (!running.length) return null;
  return (running.find((r) => !r.label.startsWith("Task Mentor")) ?? running[0]).label;
}
