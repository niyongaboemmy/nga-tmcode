/**
 * The notification policy (workflow plan §3.3), in one place: how long a
 * toast stays, which ones Do Not Disturb hides, and which ones count as
 * unread in the notification centre. Pure: the store and the widgets use it.
 *
 * | Kind       | Lifetime                                   | DND                          | Centre        |
 * |------------|--------------------------------------------|------------------------------|---------------|
 * | `hint`     | 6 s, paused on hover                       | hidden                       | no            |
 * | `result`   | 8 s, paused on hover; until dismissed if important | hidden unless important | yes           |
 * | `external` | until read                                 | hidden unless `bypassDnd`    | yes, unread   |
 * | `failure`  | until dismissed                            | shown                        | yes           |
 * | `progress` | until it finishes                          | shown                        | no            |
 */

export type NotifyKind = "result" | "external" | "progress" | "failure" | "hint";

export interface NotifyOptions {
  kind?: NotifyKind;
  /** Stays until dismissed (submit, return, release, exam notes). */
  important?: boolean;
  /** A new toast with the same key replaces the old one (exam time warnings). */
  replaceKey?: string;
  /** Adds an Undo button; the toast then lasts at least 10 s. */
  undo?: () => void;
  /** Technical text, behind a "Details" link, never in the main message. */
  details?: string;
  /** Shown in Do Not Disturb (exams, teacher messages, returned work). */
  bypassDnd?: boolean;
  /** Raised by an exam or a teacher: always shown, whatever the caller passed. */
  source?: "exam" | "teacher";
}

export const HINT_MS = 6000;
export const RESULT_MS = 8000;
export const UNDO_MS = 10_000;
/** At most this many toasts on screen; the rest wait in the centre ("+2 more"). */
export const MAX_VISIBLE_TOASTS = 3;

/** The fields of a notification the policy reads. */
export interface PolicyFields {
  severity: "info" | "warning" | "error";
  actions?: { label: string }[];
  progress?: number | null;
  cancel?: () => void;
  kind?: NotifyKind;
  important?: boolean;
  undo?: () => void;
  bypassDnd?: boolean;
}

/**
 * The kind of a notification: the one given, else what older calls meant.
 * Errors are failures; a plain info is a hint; info with buttons and warnings
 * stay until dismissed, as they always did.
 */
export function kindOf(n: PolicyFields): NotifyKind {
  if (n.kind) return n.kind;
  if (n.progress !== undefined || n.cancel) return "progress";
  if (n.severity === "error") return "failure";
  if (n.severity === "info" && !n.actions?.length && !n.undo) return "hint";
  return "result";
}

/** Milliseconds the toast stays on screen (while not hovered); null: until dismissed or finished. */
export function lifetimeOf(n: PolicyFields): number | null {
  if (n.progress !== undefined || n.cancel) return null;
  const kind = kindOf(n);
  let ms: number | null;
  switch (kind) {
    case "hint":
      ms = HINT_MS;
      break;
    case "result":
      // Older calls (no kind) with buttons or a warning stayed: keep that.
      ms = n.important || (!n.kind && (n.severity !== "info" || !!n.actions?.length)) ? null : RESULT_MS;
      break;
    default:
      ms = null;
  }
  if (ms !== null && n.undo) ms = Math.max(ms, UNDO_MS);
  return ms;
}

/** Normalises the options: exam and teacher notices always get through Do Not Disturb. */
export function withPolicy<T extends PolicyFields>(n: T, opts: NotifyOptions = {}): T & NotifyOptions {
  const forced = opts.source === "exam" || opts.source === "teacher";
  return { ...n, ...opts, bypassDnd: forced || !!opts.bypassDnd };
}

/**
 * Shown in Do Not Disturb? Errors, failures, running operations, important
 * results and anything marked bypassDnd. During an exam nothing is hidden.
 */
export function shownInDnd(n: PolicyFields, examActive = false): boolean {
  if (examActive || n.bypassDnd) return true;
  const kind = kindOf(n);
  if (n.severity === "error" || kind === "failure" || kind === "progress") return true;
  return kind === "result" && !!n.important;
}

/** Counted as unread in the centre until read (things that arrived from outside). */
export const isExternal = (n: PolicyFields) => kindOf(n) === "external";
