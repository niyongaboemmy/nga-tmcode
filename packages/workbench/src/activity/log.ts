import { create } from "zustand";

/**
 * The activity log: everything done in a folder except typing (plan C,
 * docs/AI_AND_ACTIVITY_PLAN.md). Files created, renamed, moved, copied,
 * deleted and saved; copy, cut and paste; runs, tests, terminal commands,
 * git, extensions, Task Mentor; and every use of AI, which each event names
 * (`ai`). Kept per folder in the app's store, shown in the Activity view and
 * uploaded to Task Mentor for linked projects (uploaders subscribe here).
 *
 * This module has no workbench imports, so the file system wrapper and the
 * extension host bridge can record without import cycles.
 */

export type ActivityKind = "file" | "clipboard" | "ai" | "run" | "terminal" | "git" | "extension" | "project" | "editor";

/** Who did it. "outside": a change TMCode saw on disk but didn't make (another app, a CLI agent). */
export type Actor =
  | { type: "you" }
  | { type: "extension"; id: string; name: string; ai?: boolean }
  | { type: "tmcode-ai" }
  | { type: "outside"; likely?: string };

export interface AiInvolvement {
  /** "TMCode AI", "Claude Code", "Gemini Code Assist"… */
  by: string;
  /** What the AI did: "suggestion accepted", "chat answer applied", "edited the file"… */
  how: string;
  /** The model, when known ("Auto · nvidia/nemotron-3-super:free"). */
  model?: string;
}

export interface ActivityEvent {
  id: number;
  /** Epoch ms. */
  t: number;
  kind: ActivityKind;
  /** A short verb: "create", "rename", "move", "copy", "delete", "save", "paste", "suggestion", "chat"… */
  action: string;
  /** Workspace-relative path (the new path for rename/move/copy is `to`). */
  path?: string;
  to?: string;
  /** One readable line ("Pasted 12 lines from outside TMCode"). */
  text: string;
  /** Extra facts (lengths, line counts, exit codes, prompts). Small, JSON-safe. */
  data?: Record<string, string | number | boolean | null>;
  actor: Actor;
  ai?: AiInvolvement;
  /** Repeats merged into this entry (saves of one file in a row). */
  count?: number;
}

export type ActivityInput = Omit<ActivityEvent, "id" | "t" | "actor" | "count"> & { actor?: Actor; t?: number };

const MAX_EVENTS = 5000;
/** Saves (and other repeats) of the same thing this close together are one entry. */
const MERGE_MS = 2 * 60 * 1000;

interface ActivityState {
  /** The folder the events belong to (absolute root), null when none is open. */
  root: string | null;
  events: ActivityEvent[];
}

export const useActivityLog = create<ActivityState>(() => ({ root: null, events: [] }));

type Listener = (e: ActivityEvent) => void;
const listeners = new Set<Listener>();
let seq = 0;
let persist: ((root: string, events: ActivityEvent[]) => void) | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Events not yet picked up by an uploader are delivered to listeners as they happen. */
export function onActivity(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The folder whose log is shown; `events` is what was kept for it before. */
export function setActivityFolder(root: string | null, events: ActivityEvent[] = []) {
  seq = events.reduce((m, e) => Math.max(m, e.id), 0);
  useActivityLog.setState({ root, events: events.slice(-MAX_EVENTS) });
}

/** Where the log is kept (the app's key/value store, per folder). */
export function setActivityPersistence(fn: (root: string, events: ActivityEvent[]) => void) {
  persist = fn;
}

// ── who is acting ──
// An action started by an extension (its edit, its file write) runs inside `runAs`, so the file
// system wrapper records the extension, not "you". The actor is read when each call starts. An
// async `fn` keeps its actor until it settles: the browser has no async context, so a user action
// overlapping that window (rare: these calls take milliseconds) is attributed to it too.
let current: Actor = { type: "you" };
let suppressed = 0;

export function currentActor(): Actor {
  return current;
}
export function isRecordingSuppressed() {
  return suppressed > 0;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === "function";

/** Runs `fn` with `actor` as the one acting (until it settles, when it is async). */
export function runAs<T>(actor: Actor, fn: () => T): T {
  const prev = current;
  current = actor;
  let r: T;
  try {
    r = fn();
  } catch (e) {
    current = prev;
    throw e;
  }
  if (!isThenable(r)) {
    current = prev;
    return r;
  }
  const restore = () => {
    if (current === actor) current = prev;
  };
  return Promise.resolve(r).finally(restore) as T;
}

/** TMCode's own bookkeeping writes (exam copies, starters it summarises, sync downloads) aren't recorded one by one. */
export function internally<T>(fn: () => T): T {
  suppressed++;
  let r: T;
  try {
    r = fn();
  } catch (e) {
    suppressed--;
    throw e;
  }
  if (!isThenable(r)) {
    suppressed--;
    return r;
  }
  return Promise.resolve(r).finally(() => suppressed--) as T;
}

/** The AI involvement an actor implies (an AI extension's edit is AI use even when it doesn't say so). */
export function aiOf(actor: Actor, how: string): AiInvolvement | undefined {
  if (actor.type === "tmcode-ai") return { by: "TMCode AI", how };
  if (actor.type === "extension" && actor.ai) return { by: actor.name, how };
  if (actor.type === "outside" && actor.likely) return { by: actor.likely, how: `${how} (outside the editor, while it was working)` };
  return undefined;
}

export function actorLabel(a: Actor): string {
  switch (a.type) {
    case "you":
      return "You";
    case "extension":
      return a.name;
    case "tmcode-ai":
      return "TMCode AI";
    case "outside":
      return a.likely ? `Outside TMCode (likely ${a.likely})` : "Outside TMCode";
  }
}

/** Records one action. Returns the entry (merged into the previous one when it repeats it). */
export function recordActivity(input: ActivityInput): ActivityEvent | null {
  if (suppressed > 0) return null;
  const { root, events } = useActivityLog.getState();
  if (!root) return null;
  const actor = input.actor ?? current;
  const t = input.t ?? Date.now();
  const ai = input.ai ?? aiOf(actor, input.action);
  const last = events[events.length - 1];
  // Saves of one file in a row (auto save) are one entry with a count.
  if (
    last &&
    input.action === "save" &&
    last.action === "save" &&
    last.path === input.path &&
    t - last.t < MERGE_MS &&
    JSON.stringify(last.actor) === JSON.stringify(actor) &&
    last.ai?.by === ai?.by
  ) {
    const merged: ActivityEvent = { ...last, t, count: (last.count ?? 1) + 1 };
    useActivityLog.setState({ events: [...events.slice(0, -1), merged] });
    schedulePersist();
    return merged;
  }
  const e: ActivityEvent = { ...input, id: ++seq, t, actor, ...(ai ? { ai } : {}) };
  useActivityLog.setState({ events: [...events, e].slice(-MAX_EVENTS) });
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* a listener's failure never loses the event */
    }
  }
  schedulePersist();
  return e;
}

function schedulePersist() {
  if (!persist || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { root, events } = useActivityLog.getState();
    if (root && persist) persist(root, events);
  }, 1000);
}

/** Writes the log now (before the folder changes or the app quits). */
export function flushActivity() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const { root, events } = useActivityLog.getState();
  if (root && persist) persist(root, events);
}

/** Changes an entry in place (an AI's streamed edits grow one entry instead of adding many). */
export function updateActivity(id: number, patch: Partial<Omit<ActivityEvent, "id">>) {
  const { events } = useActivityLog.getState();
  const i = events.findIndex((e) => e.id === id);
  if (i < 0) return;
  const next = events.slice();
  next[i] = { ...events[i], ...patch };
  useActivityLog.setState({ events: next });
  schedulePersist();
}

export function clearActivity() {
  useActivityLog.setState({ events: [] });
  flushActivity();
}

/** Plain text of a size: "1 line, 12 characters". */
export function sizeText(text: string) {
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  return `${lines} line${lines === 1 ? "" : "s"}, ${text.length} character${text.length === 1 ? "" : "s"}`;
}
