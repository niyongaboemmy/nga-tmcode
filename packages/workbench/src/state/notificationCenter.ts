import { create } from "zustand";
import { dismissNotification, frontEditorIds, getPlatform, useWorkbench, type Notification } from "./store";
import { isExternal, kindOf, ownerOnScreen, shownInDnd, type NotifyKind } from "./notifications";

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
  /** What it is about: a newer entry about the same thing replaces this one (no stale "returned" after "graded"). */
  owner?: string;
}

/** Kept 30 days, at most this many (N8). */
const MAX_HISTORY = 200;
const HISTORY_DAYS = 30;
const HISTORY_KEY = "notifications.history";

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
    if (at < 0) {
      // The newest state of a thing wins: its older entries (and their buttons) go.
      if (n.owner) out = out.filter((h) => h.owner !== n.owner);
      out = [{ id: n.id, severity: n.severity, message: n.message, time: now, kind: kindOf(n), ...(n.owner ? { owner: n.owner } : {}), ...(isExternal(n) && !n.silent ? { unread: true } : {}) }, ...out];
    }
    else if (out[at].message !== n.message || out[at].severity !== n.severity) {
      out = out.map((h, i) => (i === at ? { ...h, message: n.message, severity: n.severity } : h));
    }
  }
  return out.length > MAX_HISTORY ? out.slice(0, MAX_HISTORY) : out;
}

/** Pure: what is saved (and loaded): the last 30 days, at most 200 entries. */
export function pruneHistory(history: HistoryEntry[], now: number): HistoryEntry[] {
  const since = now - HISTORY_DAYS * 86_400_000;
  return history.filter((h) => h.time >= since).slice(0, MAX_HISTORY);
}

// Buttons that outlive their toast (View Feedback, Open…), for this session.
type KeptAction = NonNullable<Notification["actions"]>[number];
const kept = new Map<number, KeptAction[]>();

/** The buttons a closed entry still offers: kept ones whose check still passes. */
export function keptActions(id: number): KeptAction[] {
  return (kept.get(id) ?? []).filter((a) => (typeof a.keep === "function" ? a.keep() : !!a.keep));
}

let wired = false;
export function wireNotificationCenter() {
  if (wired) return;
  wired = true;
  const sync = (toasts: Notification[]) => {
    const s = useNotificationCenter.getState();
    for (const n of toasts) {
      const keep = n.actions?.filter((a) => a.keep);
      if (keep?.length) kept.set(n.id, keep);
    }
    const next = recordToasts(s.history, toasts, Date.now());
    if (next !== s.history) useNotificationCenter.setState({ history: next });
  };
  // N8: the history survives a restart (30 days). Loaded entries get ids of their own (negative),
  // so they never meet this session's toasts.
  let loaded = false;
  void getPlatform()
    .store.get<HistoryEntry[]>(HISTORY_KEY)
    .then((saved) => {
      loaded = true;
      if (!Array.isArray(saved) || !saved.length) return;
      const old = pruneHistory(saved, Date.now()).map((h, i) => ({ ...h, id: -(i + 1) }));
      const s = useNotificationCenter.getState();
      useNotificationCenter.setState({ history: [...s.history, ...old].slice(0, MAX_HISTORY) });
    })
    .catch(() => {
      loaded = true;
    });
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  useNotificationCenter.subscribe((s, prev) => {
    if (s.history === prev.history || !loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void getPlatform().store.set(HISTORY_KEY, pruneHistory(s.history, Date.now())).catch(() => {}), 800);
  });
  sync(useWorkbench.getState().notifications);
  useWorkbench.subscribe((s, prev) => {
    if (s.notifications !== prev.notifications) sync(s.notifications);
    // A toast whose thing comes on screen (its brief opened) has said what it had to say: it retires to the centre.
    if (s.groups !== prev.groups) {
      const fronts = frontEditorIds(s);
      for (const n of s.notifications) {
        if (n.owner && n.severity !== "error" && n.kind !== "failure" && ownerOnScreen(n.owner, fronts)) {
          markRead(n.id);
          dismissNotification(n.id);
        }
      }
    }
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

/** Notifications: Mark All as Read. */
export const markAllAsRead = () => markAllRead();

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
