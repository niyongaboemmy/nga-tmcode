import { create } from "zustand";
import { dismissNotification, getPlatform, useWorkbench, type Notification } from "./store";

/**
 * VS Code's notification centre: every toast of this session, newest first,
 * including the ones already closed (their buttons only while the toast is
 * still open, so a stale "Discard my changes" can never run). Do Not Disturb
 * keeps everything but errors out of the toasts; the centre still has them.
 */

export interface HistoryEntry {
  id: number;
  severity: Notification["severity"];
  message: string;
  time: number;
}

const MAX_HISTORY = 100;

interface CenterState {
  open: boolean;
  dnd: boolean;
  history: HistoryEntry[];
}

export const useNotificationCenter = create<CenterState>(() => ({ open: false, dnd: false, history: [] }));

/** Pure: the history after the toasts changed (new ones added, updated messages kept current). */
export function recordToasts(history: HistoryEntry[], toasts: Notification[], now: number): HistoryEntry[] {
  let out = history;
  for (const n of toasts) {
    const at = out.findIndex((h) => h.id === n.id);
    if (at < 0) out = [{ id: n.id, severity: n.severity, message: n.message, time: now }, ...out];
    else if (out[at].message !== n.message || out[at].severity !== n.severity) {
      out = out.map((h, i) => (i === at ? { ...h, message: n.message, severity: n.severity } : h));
    }
  }
  return out.length > MAX_HISTORY ? out.slice(0, MAX_HISTORY) : out;
}

let wired = false;
export function wireNotificationCenter() {
  if (wired) return;
  wired = true;
  const sync = (toasts: Notification[]) => {
    const s = useNotificationCenter.getState();
    const next = recordToasts(s.history, toasts, Date.now());
    if (next !== s.history) useNotificationCenter.setState({ history: next });
  };
  sync(useWorkbench.getState().notifications);
  useWorkbench.subscribe((s, prev) => {
    if (s.notifications !== prev.notifications) sync(s.notifications);
  });
  void getPlatform()
    .store.get<boolean>("notifications.doNotDisturb")
    .then((dnd) => dnd && useNotificationCenter.setState({ dnd: true }))
    .catch(() => {});
}

export function showNotificationCenter(open = true) {
  useNotificationCenter.setState({ open });
}

export function toggleNotificationCenter() {
  showNotificationCenter(!useNotificationCenter.getState().open);
}

/** Notifications: Clear All Notifications — the toasts and the centre's list. */
export function clearAllNotifications() {
  for (const n of useWorkbench.getState().notifications) {
    // A running operation keeps its toast: closing it must not hide the Cancel button.
    if (n.progress === undefined && !n.cancel) dismissNotification(n.id);
  }
  const live = new Set(useWorkbench.getState().notifications.map((n) => n.id));
  useNotificationCenter.setState({ history: useNotificationCenter.getState().history.filter((h) => live.has(h.id)) });
}

export function clearNotification(id: number) {
  const n = useWorkbench.getState().notifications.find((x) => x.id === id);
  if (n && n.progress === undefined && !n.cancel) dismissNotification(id);
  if (!useWorkbench.getState().notifications.some((x) => x.id === id)) {
    useNotificationCenter.setState({ history: useNotificationCenter.getState().history.filter((h) => h.id !== id) });
  }
}

export function toggleDoNotDisturb() {
  const dnd = !useNotificationCenter.getState().dnd;
  useNotificationCenter.setState({ dnd });
  void getPlatform().store.set("notifications.doNotDisturb", dnd);
}

/** Toasts shown: in Do Not Disturb, errors and running operations only. */
export function visibleToasts(toasts: Notification[], dnd: boolean) {
  return dnd ? toasts.filter((n) => n.severity === "error" || n.progress !== undefined || !!n.cancel) : toasts;
}
