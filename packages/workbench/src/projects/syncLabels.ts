import type { SyncState } from "./types";

/**
 * One vocabulary for the open folder's sync with Task Mentor: the Projects
 * view's sync line, the status bar item and the brief's working card all say
 * the same words (Saved online / Not saved yet / Newer version online /
 * Conflicts to resolve / Saving… / Offline / Sync problem).
 */

/** Short: the sync row shares the side bar's width with Save. The tooltip says it in full. */
export const SYNC_LABEL: Record<SyncState, string> = {
  unbound: "Not connected",
  checking: "Checking…",
  synced: "Saved online",
  "local-changes": "Not saved yet",
  "remote-changes": "Newer version online",
  both: "Changed here and online",
  conflict: "Conflicts to resolve",
  saving: "Saving…",
  pulling: "Getting the latest…",
  offline: "Offline",
  error: "Sync problem",
};

export const SYNC_TIP: Record<SyncState, string> = {
  unbound: "This folder is not a Task Mentor project",
  checking: "Comparing this folder with Task Mentor",
  synced: "Everything here is saved to Task Mentor",
  "local-changes": "Changes in this folder are not saved to Task Mentor yet: Save to Task Mentor",
  "remote-changes": "Task Mentor has newer changes: Get Latest",
  both: "Changes here and in Task Mentor: Save to Task Mentor and Get Latest",
  conflict: "The same files changed here and in Task Mentor",
  saving: "Saving to Task Mentor",
  pulling: "Getting the latest from Task Mentor",
  offline: "Task Mentor can't be reached",
  error: "Sync problem",
};

export const SYNC_ICON: Record<SyncState, string> = {
  unbound: "circle-slash",
  checking: "sync",
  synced: "cloud",
  "local-changes": "cloud-upload",
  "remote-changes": "cloud-download",
  both: "arrow-swap",
  conflict: "warning",
  saving: "sync",
  pulling: "sync",
  offline: "debug-disconnect",
  error: "error",
};

/** Colour semantics: green saved, orange needs attention, red problem, blue working/info. */
export const SYNC_TONE: Record<SyncState, "success" | "attention" | "error" | "info" | "muted"> = {
  unbound: "muted",
  checking: "info",
  synced: "success",
  "local-changes": "attention",
  "remote-changes": "info",
  both: "attention",
  conflict: "attention",
  saving: "info",
  pulling: "info",
  offline: "muted",
  error: "error",
};

export const SYNC_BUSY = (s: SyncState) => s === "saving" || s === "pulling" || s === "checking";

/** "just now", "2 min ago", "3 h ago", "yesterday", or a date. */
export function agoText(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return "yesterday";
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
}

/** The sync line in words: "Saved online · 2 min ago", "Not saved yet · 3 changes". */
export function syncLineText(sync: SyncState, opts: { changes?: number; savedAt?: number | null; now?: number } = {}) {
  const base = SYNC_LABEL[sync];
  if (sync === "synced" && opts.savedAt) return `${base} · ${agoText(opts.savedAt, opts.now)}`;
  if ((sync === "local-changes" || sync === "both") && opts.changes) return `${base} · ${opts.changes} change${opts.changes === 1 ? "" : "s"}`;
  return base;
}
