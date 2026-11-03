import { dismissNotification, notify, showDialog, useWorkbench } from "../state/store";

/**
 * window.showInformationMessage / Warning / Error from extensions. A question
 * asked again while the first is still up (Gemini Code Assist's survey, ~600
 * times) joins the open toast instead of stacking a new one.
 */

/** Open extension toasts by what they say: the same question again joins the open one instead of stacking. */
const openMessages = new Map<string, { id: number; waiters: ((v: number | null) => void)[] }>();
let watchingMessages = false;

/** One subscription for every open extension toast (one each made every store change O(toasts²) and froze the window). */
function watchMessages() {
  if (watchingMessages) return;
  watchingMessages = true;
  useWorkbench.subscribe((s, prev) => {
    if (s.notifications === prev.notifications || !openMessages.size) return;
    const live = new Set(s.notifications.map((n) => n.id));
    for (const [key, m] of [...openMessages]) {
      // Closed (or timed out, or pushed out) without a choice: undefined, as in VS Code.
      if (m.id && !live.has(m.id)) settleMessage(key, null);
    }
  });
}

function settleMessage(key: string, v: number | null) {
  const m = openMessages.get(key);
  if (!m) return;
  openMessages.delete(key);
  for (const w of m.waiters) w(v);
}

export function showMessage(severity: "info" | "warning" | "error", message: string, opts: { modal?: boolean; detail?: string }, items: string[]): Promise<number | null> {
  if (opts.modal) {
    const buttons = items.map((label, i) => ({ id: String(i), label, primary: i === 0 }));
    return showDialog({ message, detail: opts.detail, severity: severity === "info" ? "info" : "warning", buttons: [...buttons, { id: "cancel", label: "Cancel" }], cancelId: "cancel" }).then((id) => (id === "cancel" ? null : Number(id)));
  }
  watchMessages();
  const key = JSON.stringify([severity, message, items]);
  return new Promise((resolve) => {
    const open = openMessages.get(key);
    if (open) {
      // Asked again while the first is still up: both get the one answer.
      open.waiters.push(resolve);
      return;
    }
    // id 0 until notify returns: the watcher skips it (notify's own store change runs it first).
    const entry = { id: 0, waiters: [resolve] };
    openMessages.set(key, entry);
    entry.id = notify(
      severity,
      message,
      items.length
        ? items.map((label, i) => ({
            label,
            run: () => {
              settleMessage(key, i);
              dismissNotification(entry.id);
            },
          }))
        : undefined,
      // The centre keeps one entry per message, however often the extension says it.
      { owner: `ext:${key}` },
    );
  });
}
