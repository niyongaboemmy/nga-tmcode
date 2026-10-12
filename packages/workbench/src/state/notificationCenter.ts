import { create } from "zustand";
import { dismissNotification, getPlatform, useWorkbench, type Notification } from "./store";
import { isExternal, kindOf, shownInDnd, type NotifyKind } from "./notifications";

/**
 * VS Code's notification centre: every toast of this session, newest first,
 * including the ones already closed (their buttons only while the toast is
 * still open, so a stale "Discard my changes" can never run). Do Not Disturb
 * keeps hints and ordinary results out of the toasts (state/notifications.ts
 * says which); the centre still has them. Things that arrived from outside
 * (new work, grades, returned work) stay unread until seen: the bell counts them.
 */

export interface HistoryEntry {
  id: number;
  severity: Notification["severity"];
  message: string;
  time: number;
  kind?: NotifyKind;
  /** Arrived from outside and not seen yet (the bell's count). */
  unread?: boolean;
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
    if (at < 0) out = [{ id: n.id, severity: n.severity, message: n.message, time: now, kind: kindOf(n), ...(isExternal(n) ? { unread: true } : {}) }, ...out];
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
  const was = useNotificationCenter.getState().open;
  useNotificationCenter.setState({ open });
  // Seen once the centre was open: the new ones stand out while it is, then count as read.
  if (was && !open) markAllRead();
}

/** How many things that arrived from outside haven't been seen yet. */
export const unreadCount = (history: HistoryEntry[]) => history.filter((h) => h.unread).length;

/** Seen: closed, or its button used. */
export function markRead(id: number) {
  const h = useNotificationCenter.getState().history;
  if (h.some((x) => x.id === id && x.unread)) useNotificationCenter.setState({ history: h.map((x) => (x.id === id ? { ...x, unread: false } : x)) });
}

export function markAllRead() {
  const h = useNotificationCenter.getState().history;
  if (h.some((x) => x.unread)) useNotificationCenter.setState({ history: h.map((x) => (x.unread ? { ...x, unread: false } : x)) });
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

/**
 * Toasts shown. In Do Not Disturb: errors, failures, running operations,
 * important results and what bypasses it (exams, teacher messages, returned
 * work). During an exam Do Not Disturb hides nothing.
 */
export function visibleToasts(toasts: Notification[], dnd: boolean, examActive = false) {
  return dnd ? toasts.filter((n) => shownInDnd(n, examActive)) : toasts;
}
