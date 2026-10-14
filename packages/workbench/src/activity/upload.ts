import { getPlatform } from "../state/store";
import { useProjects } from "../projects/service";
import { onActivity, type ActivityEvent } from "./log";

/**
 * Sends the activity log of a folder linked to a Task Mentor project (an assignment, a practical)
 * to Task Mentor, where the teacher sees it while grading. Batches go every 20 s (or at 40
 * events), each with an id so a retry is stored once; what couldn't be sent waits in TMCode's
 * store until the next try, even across restarts. Before a submit, the batch is sent first.
 */

const FLUSH_MS = 20_000;
const MAX_BATCH = 40;
const key = (projectId: number) => `activity.pending.${projectId}`;

type Wire = Omit<ActivityEvent, "id">;
let pending: { projectId: number; events: Wire[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;

function boundProject(): number | null {
  const b = useProjects.getState().binding;
  return b && b.kind === "tm" && useProjects.getState().account?.signed_in ? b.project_id : null;
}

function wire(e: ActivityEvent): Wire {
  const { id: _id, ...rest } = e;
  return rest;
}

async function persist() {
  if (!pending) return;
  await getPlatform()
    .store.set(key(pending.projectId), pending.events)
    .catch(() => undefined);
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushActivityUpload();
  }, FLUSH_MS);
}

/** Sends what is waiting now (before a submit, on quit). */
export async function flushActivityUpload(): Promise<void> {
  if (sending) return sending;
  sending = (async () => {
    try {
      const projectId = pending?.projectId ?? boundProject();
      if (!projectId) return;
      const stored = (await getPlatform().store.get<Wire[]>(key(projectId)).catch(() => undefined)) ?? [];
      const events = pending?.projectId === projectId ? pending.events : stored;
      if (!events.length) return;
      const host = getPlatform().account;
      if (!host) return;
      for (let i = 0; i < events.length; i += 500) {
        const batch = events.slice(i, i + 500);
        const res = await host.request({ method: "POST", path: `/api/tmcode/projects/${projectId}/activity`, json: { batch: crypto.randomUUID(), events: batch } });
        if (res.status >= 300) throw new Error(`Task Mentor answered ${res.status}`);
      }
      if (pending?.projectId === projectId) pending.events = pending.events.slice(events.length);
      await getPlatform().store.set(key(projectId), pending?.projectId === projectId ? pending.events : []);
    } catch {
      // Offline or signed out: it stays waiting (persisted) and goes with the next batch.
      await persist();
      schedule();
    } finally {
      sending = null;
    }
  })();
  return sending;
}

let wired = false;
export function wireActivityUpload() {
  if (wired) return;
  wired = true;
  onActivity((e) => {
    const projectId = boundProject();
    if (!projectId) return;
    if (pending && pending.projectId !== projectId) {
      void persist();
      pending = null;
    }
    pending ??= { projectId, events: [] };
    pending.events.push(wire(e));
    if (pending.events.length >= MAX_BATCH) void flushActivityUpload();
    else schedule();
  });
  // A folder opened with events still waiting from last time: send them.
  useProjects.subscribe((s, prev) => {
    if (s.binding?.project_id !== prev.binding?.project_id || s.account?.signed_in !== prev.account?.signed_in) void flushActivityUpload();
  });
  window.addEventListener("beforeunload", () => void persist());
}
