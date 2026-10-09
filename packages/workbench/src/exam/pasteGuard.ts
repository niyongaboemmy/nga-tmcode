import type { PastePolicy } from "@tmcode/protocol";
import { notify, useWorkbench } from "../state/store";

/**
 * The exam's paste policy (plan §10.1): "internal_only" lets a student paste
 * only text copied or cut inside TMCode during the exam; "block" refuses
 * every paste. Shared by the editors and the terminal.
 */

/** Text copied or cut inside TMCode since the exam started, newest last. */
const ring: string[] = [];
const RING_SIZE = 50;
const norm = (s: string) => s.replace(/\r\n?/g, "\n");

export function rememberCopy(text: string) {
  if (!text) return;
  const t = norm(text);
  const at = ring.indexOf(t);
  if (at >= 0) ring.splice(at, 1);
  ring.push(t);
  if (ring.length > RING_SIZE) ring.shift();
}

/** Forgets what was copied before (a new exam must not inherit practice copies). */
export function resetCopies() {
  ring.length = 0;
}

/** Why a paste is refused under the current policy, or null when it may go in. */
export function pasteRefusal(text: string, policy: PastePolicy = useWorkbench.getState().policy.paste): string | null {
  if (policy === "allow" || !text) return null;
  if (policy === "block") return "Pasting is off in this exam.";
  const t = norm(text);
  return ring.some((c) => c.includes(t)) ? null : "Pasting from outside TMCode is off in this exam.";
}

let lastNotice = 0;
export function refusePaste(message: string) {
  // One notice per burst (a held ⌘V must not stack toasts).
  if (Date.now() - lastNotice < 1500) return;
  lastNotice = Date.now();
  notify("info", message);
}

let tracking = false;
/** Records every copy and cut made in the app (editors, terminal, inputs). Idempotent. */
export function trackCopies() {
  if (tracking) return;
  tracking = true;
  const onCopy = (e: ClipboardEvent) => {
    // Bubble phase: Monaco and xterm have already put their text on the event.
    const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString() || "";
    rememberCopy(text);
  };
  window.addEventListener("copy", onCopy);
  window.addEventListener("cut", onCopy);
}
