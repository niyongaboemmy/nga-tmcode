import { recordActivity, updateActivity, useActivityLog, type ActivityInput } from "../activity/log";

/**
 * One Activity entry per run. The Run hub records "Ran main.py" when a ▶ is
 * pressed and hands the entry to the runner that starts (Run panel, JavaScript
 * Console, Task Mentor), which adds its command line and, when the program
 * ends, its exit code and duration, in place. A runner started without the hub
 * (a command, Run with Arguments…) records its own entry.
 */

let handoff: number | null = null;

/** Records the hub's entry for `fn`'s run; the runner `fn` starts takes it over instead of adding another. */
export async function withRunActivity<T>(input: ActivityInput, fn: () => Promise<T> | T): Promise<T> {
  const prev = handoff;
  handoff = recordActivity(input)?.id ?? null;
  try {
    return await fn();
  } finally {
    handoff = prev;
  }
}

/** A runner's entry: the one the hub just recorded for this run (its text kept, path and data added), or a new one. */
export function recordRun(input: ActivityInput): number | null {
  if (handoff !== null) {
    const id = handoff;
    handoff = null;
    const e = useActivityLog.getState().events.find((x) => x.id === id);
    if (e) {
      updateActivity(id, { path: e.path ?? input.path, data: { ...input.data, ...e.data, ...pick(input.data, ["command", "profile", "language", "files"]) } });
      return id;
    }
  }
  return recordActivity(input)?.id ?? null;
}

const pick = (d: ActivityInput["data"], keys: string[]) => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => keys.includes(k)));

export type RunEnd =
  | { status: "running" }
  | {
      status: "ok" | "error" | "stopped" | "timed-out" | "too-much-output" | "build-failed";
      exit?: number | null;
      duration_ms?: number;
    };

/** How a run ended, from the runner's exit event. */
export function runEndOf(e: { code: number | null; killed?: boolean; timed_out?: boolean; truncated?: boolean; duration_ms?: number; phase?: "build" | "run" }): RunEnd {
  const status = e.killed ? "stopped" : e.timed_out ? "timed-out" : e.truncated ? "too-much-output" : e.phase === "build" && e.code !== 0 ? "build-failed" : e.code === 0 ? "ok" : "error";
  return { status, exit: e.code, ...(e.duration_ms !== undefined ? { duration_ms: Math.round(e.duration_ms) } : {}) };
}

/** Writes the run's result on its entry (exit code, duration, how it ended). */
export function finishRun(id: number | null, end: RunEnd) {
  if (id === null) return;
  const e = useActivityLog.getState().events.find((x) => x.id === id);
  if (!e) return;
  const data: Record<string, string | number | boolean | null> = { ...e.data, status: end.status };
  if ("exit" in end && end.exit !== undefined) data.exit = end.exit;
  else delete data.exit;
  if ("duration_ms" in end && end.duration_ms !== undefined) data.duration_ms = end.duration_ms;
  updateActivity(id, { data });
}

/** The command line the runner echoed ("node sum.js"), shown as the entry's command. */
export function setRunCommand(id: number | null, command: string) {
  if (id === null || !command.trim()) return;
  const e = useActivityLog.getState().events.find((x) => x.id === id);
  if (!e || e.data?.command) return;
  updateActivity(id, { data: { ...e.data, command: command.replace(/\s+\((browser sandbox|[^)]*sandbox[^)]*)\)$/, "").trim().slice(0, 500) } });
}
