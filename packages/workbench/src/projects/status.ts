import type { AssignmentSummary } from "./assignments";
import type { Project } from "./types";

/**
 * One student status (workflow plan §3.2, W4). The brief's header and card,
 * the side-bar card and stepper, the Assignments row, the status bar and Home
 * all read this one derived value, so they can never disagree.
 *
 * Two sources: the assignment payload (`my.*`) is authoritative for grading
 * and return; the open project (`status`) for local work (submit, withdraw).
 * When they disagree for a moment (one was refreshed, the other not yet), the
 * answer is still one status, with `syncing: true` (shown as "Updating…"), and
 * the caller quietly refreshes the stale side.
 */

export type StudentStatus = "not_started" | "in_progress" | "submitted" | "returned" | "graded" | "closed";

export const STATUS_LABEL: Record<StudentStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
  returned: "Returned",
  graded: "Graded",
  closed: "Closed",
};

export type ActionId = "start" | "continue" | "save" | "submit" | "withdraw" | "view_feedback" | "open_work" | "open_in_tm";

export interface Action {
  id: ActionId;
  label: string;
}

export interface StatusView {
  status: StudentStatus;
  /** The two sources disagree for a moment: show "Updating…" (one status, never two). */
  syncing: boolean;
  /** The ONE button for this state (null: nothing to do). */
  primary: Action | null;
  /** Shown in a "…" menu, or as the quiet second button on the brief (Save to Task Mentor). */
  secondary: Action[];
  /** "You're working on it", "Returned by your teacher", … */
  headline: string;
  /** The assignment's workspace is the folder open now. */
  here: boolean;
}

export interface DeriveContext {
  /** The open folder is this assignment's workspace (`project` is then the open project). */
  here: boolean;
}

const A = {
  start: { id: "start", label: "Start" },
  continue: { id: "continue", label: "Continue" },
  save: { id: "save", label: "Save to Task Mentor" },
  submit: { id: "submit", label: "Submit" },
  submitAgain: { id: "submit", label: "Submit Again" },
  withdraw: { id: "withdraw", label: "Withdraw to Edit" },
  feedback: { id: "view_feedback", label: "View Feedback" },
  openWork: { id: "open_work", label: "Continue" },
  openTm: { id: "open_in_tm", label: "Open in Task Mentor" },
} as const satisfies Record<string, Action>;

/** Task Mentor still takes submissions (false once the teacher closes it; older servers: open unless completed). */
export function acceptsWork(a: AssignmentSummary): boolean {
  return !a.read_only && a.accepts_submissions !== false;
}

/** The status alone, from both sources (see deriveStatus for the buttons). */
export function resolveStatus(a: AssignmentSummary, p: Project | null): { status: StudentStatus; syncing: boolean } {
  const mine = a.my?.state ?? "not_started";
  // The project's lifecycle only counts when the server has it and it is this assignment's workspace.
  const ps = p?.status;
  const returned = !!a.my?.returned_at;

  // Graded: the assignment payload says so (the grade and feedback are there). A project that still says
  // "submitted" or "draft" hasn't caught up yet.
  if (mine === "graded") return { status: "graded", syncing: !!ps && ps !== "graded" && ps !== "removed" };
  // The project already says graded but the list hasn't: graded (and the list catches up).
  if (ps === "graded") return { status: "graded", syncing: true };
  // Completed by the teacher (read-only): nothing more to do.
  if (a.read_only) return { status: "closed", syncing: false };

  // Returned for changes (assignment payload is authoritative): a project still marked "submitted" is stale.
  if (returned && mine === "in_progress") return { status: acceptsWork(a) ? "returned" : "closed", syncing: ps === "submitted" };

  if (mine === "submitted") {
    // Withdrawn here a moment ago: the project knows first.
    if (ps === "draft") return { status: acceptsWork(a) ? (returned ? "returned" : "in_progress") : "closed", syncing: true };
    return { status: "submitted", syncing: false };
  }
  // Just submitted here: the project knows first.
  if (ps === "submitted") return { status: "submitted", syncing: true };

  if (!acceptsWork(a)) return { status: "closed", syncing: false };
  if (mine === "in_progress" || (p && ps !== "removed")) return { status: "in_progress", syncing: mine === "not_started" && !!p };
  return { status: "not_started", syncing: false };
}

const HEADLINE: Record<StudentStatus, (here: boolean, a: AssignmentSummary) => string> = {
  not_started: () => "Start this assignment",
  in_progress: (here) => (here ? "You're working on it in this window" : "Continue your work"),
  returned: () => "Returned by your teacher",
  submitted: () => "Submitted",
  graded: () => "Graded",
  closed: (_here, a) => (a.read_only ? "Completed" : "Closed"),
};

/** The one status, its one primary button and the rest (in a menu). */
export function deriveStatus(a: AssignmentSummary, p: Project | null, ctx: DeriveContext): StatusView {
  const here = ctx.here;
  const { status, syncing } = resolveStatus(a, here ? p : null);
  const started = !!a.my?.project_id || (here && !!p);
  let primary: Action | null = null;
  let secondary: Action[] = [];
  switch (status) {
    case "not_started":
      primary = A.start;
      break;
    case "in_progress":
      primary = here ? A.submit : A.continue;
      secondary = here ? [A.save] : [];
      break;
    case "returned":
      primary = here ? A.submitAgain : A.continue;
      secondary = here ? [A.save] : [];
      break;
    case "submitted":
      primary = here ? A.withdraw : A.continue;
      break;
    case "graded":
      primary = A.feedback;
      secondary = here ? [] : [A.openWork];
      break;
    case "closed":
      primary = started && !here ? A.openWork : null;
      break;
  }
  return { status, syncing, primary, secondary: [...secondary, A.openTm], headline: HEADLINE[status](here, a), here };
}
