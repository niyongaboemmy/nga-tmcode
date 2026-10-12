import { create } from "zustand";
import { inExam } from "../exam/state";
import { isFirstRun, openSpecialEditor, revealView, useWorkbench } from "../state/store";
import { SIGN_IN_EXPIRED, studentStatus, useAssignments, type AssignmentSummary } from "./assignments";
import { signOut, useProjects } from "./service";
import type { Link, LinkItem, Project } from "./types";

/**
 * The student's home (0.11 "One place for my work"): the Assignments view,
 * the session-ended banner, and the one-time reveal after the first sign-in.
 */

interface SessionState {
  /** The NGA session ended without the student signing out (expired, signed out elsewhere). */
  ended: boolean;
}
export const useSession = create<SessionState>(() => ({ ended: false }));

let intentional = false;
/** Sign Out chosen here: not a "session ended". */
export async function signOutOnPurpose() {
  intentional = true;
  try {
    await signOut();
  } finally {
    // Cancelled: the next sign-out is not on purpose (unless chosen again).
    if (useProjects.getState().account?.signed_in) intentional = false;
  }
}

const REVEALED = "tmcode:assignments-revealed";
const readFlag = () => {
  try {
    return localStorage.getItem(REVEALED) === "1";
  } catch {
    return true;
  }
};
const writeFlag = () => {
  try {
    localStorage.setItem(REVEALED, "1");
  } catch {
    /* private mode: it may show again, nothing worse */
  }
};

/** First run on this computer, already signed in: the side bar starts where the work is (Assignments or Grading), not the Explorer (W1). */
function firstRunView() {
  const at = useWorkbench.getState();
  if (!isFirstRun() || inExam() || at.policy.mode !== "practice") return;
  void import("../state/role").then(async ({ whenRoleResolved, isTeacherRole }) => {
    const { role } = await whenRoleResolved(4000);
    // The student may have chosen a view meanwhile: theirs wins.
    if (role === "unknown" || inExam() || useWorkbench.getState().activeView !== "explorer") return;
    revealView(isTeacherRole(role) ? "grading" : "assignments");
  });
}

let wired = false;
export function wireStudentHome() {
  if (wired) return;
  wired = true;
  let prev = useProjects.getState().account;
  let startup = true;
  const atStartup = (signed: boolean) => {
    if (!startup) return;
    startup = false;
    if (signed) firstRunView();
  };
  if (prev) atStartup(!!prev.signed_in);
  useProjects.subscribe((s) => {
    const acc = s.account;
    if (acc === prev) return;
    const was = prev;
    prev = acc;
    if (!acc) return;
    // The account's first answer at startup (not a sign-in now).
    if (!was) atStartup(!!acc.signed_in);
    if (acc.signed_in) {
      intentional = false;
      if (useSession.getState().ended) useSession.setState({ ended: false });
      // The first successful sign-in on this computer: show where the work is. Teachers get
      // Grading, students Assignments; if the role isn't known within 4 s, Home explains both (W2).
      if (was && !was.signed_in && !readFlag() && !inExam() && useWorkbench.getState().policy.mode === "practice") {
        writeFlag();
        void import("../state/role").then(async ({ whenRoleResolved, isTeacherRole }) => {
          const { role, resolved } = await whenRoleResolved(4000);
          if (inExam() || !useProjects.getState().account?.signed_in) return;
          if (!resolved && role === "unknown") return openSpecialEditor("welcome");
          revealView(isTeacherRole(role) ? "grading" : "assignments");
        });
      }
      return;
    }
    const ended = (!!was?.signed_in && !intentional) || (!!acc.error && !intentional);
    if (ended !== useSession.getState().ended) useSession.setState({ ended });
    if (was?.signed_in) intentional = false;
  });
}

/** The session ended (signed out by expiry or elsewhere), or Task Mentor says the sign-in expired. */
export function useSessionEnded() {
  const ended = useSession((s) => s.ended);
  const signedIn = useProjects((s) => !!s.account?.signed_in);
  const accountError = useProjects((s) => !s.account?.signed_in && !!s.account?.error);
  const expired = useAssignments((s) => s.errorKind === "scope" && s.error === SIGN_IN_EXPIRED);
  return (!signedIn && (ended || accountError)) || (signedIn && expired);
}

/** "today", "tomorrow", "Fri", "12 Oct" (and "was due Fri" is the caller's). */
export function dayLabel(t: number, now = Date.now()) {
  const d = new Date(t);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(d) - start(new Date(now))) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** "Fri 9:00": when a quiz opens. */
export function opensLabel(t: number, now = Date.now()) {
  const time = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = dayLabel(t, now);
  return `${day === "today" ? "today" : day === "tomorrow" ? "tomorrow" : day} ${time}`;
}

/** Is the open folder a student's workspace for an assignment or a quiz practical? */
export function isAssessmentWorkspace(project: Project | null, bound: boolean) {
  if (!bound || !project) return false;
  if (project.assignment) return true;
  const links = Array.isArray(project.links) ? (project.links as Link[]) : (project.links?.items ?? []);
  return links.some((l: LinkItem) => l.activity_type === "assignment" || !!l.question_id);
}

export type PracticalState = "not_started" | "in_progress" | "submitted" | "graded";

/** Where the student stands on a quiz's practical question, from their projects (and the payload when it says). */
export function practicalStateOf(quizId: number, questionId: number, projects: Project[] | null, current: Project | null): { state: PracticalState; project: Project | null } {
  const linksOf = (p: Project): LinkItem[] => (Array.isArray(p.links) ? (p.links as Link[]) : (p.links?.items ?? []));
  const matches = (p: Project) => linksOf(p).find((l) => l.activity_type === "quiz" && l.activity_id === quizId && l.question_id === questionId);
  // The open project is the freshest (it follows saves and submits).
  const candidates = [...(current ? [current] : []), ...(projects ?? []).filter((p) => p.id !== current?.id)];
  for (const p of candidates) {
    const link = matches(p);
    if (!link) continue;
    if (p.status === "graded") return { state: "graded", project: p };
    if (p.status === "submitted" || link.status === "submitted") return { state: "submitted", project: p };
    return { state: "in_progress", project: p };
  }
  return { state: "not_started", project: null };
}

const dueOf = (a: AssignmentSummary) => (a.due_date ? Date.parse(a.due_date) : Infinity);
const bySoonest = (x: AssignmentSummary, y: AssignmentSummary) => dueOf(x) - dueOf(y) || x.id - y.id;

/**
 * Home's "Next up" (workflow plan 5.2): the ONE assignment to work on now.
 * Returned work first (the teacher is waiting), then the open folder's
 * assignment if it is in progress, then the soonest-due thing to do.
 * Null: nothing to do.
 */
export function nextUp(list: AssignmentSummary[] | null, openAssignmentId: number | null = null): AssignmentSummary | null {
  const active = (list ?? []).filter((a) => !a.read_only);
  const returned = active.filter((a) => studentStatus(a) === "returned").sort(bySoonest);
  if (returned.length) return returned[0];
  const here = openAssignmentId !== null ? active.find((a) => a.id === openAssignmentId && studentStatus(a) === "in_progress") : undefined;
  if (here) return here;
  const todo = active.filter((a) => {
    const s = studentStatus(a);
    return s === "in_progress" || s === "not_started";
  });
  return todo.sort(bySoonest)[0] ?? null;
}

/** Why Next up chose `a` (the kicker's first words): "Returned", "Open now", "Late", "Due soonest", "Not started". */
export function nextUpReason(a: AssignmentSummary, openAssignmentId: number | null = null, now = Date.now()): string {
  const s = studentStatus(a);
  if (s === "returned") return "Returned to you";
  if (a.id === openAssignmentId && s === "in_progress") return "Open now";
  if (a.due_date && Date.parse(a.due_date) < now) return "Late";
  if (a.due_date) return "Due soonest";
  return s === "in_progress" ? "In progress" : "Not started";
}

/** Home's counters: Returned (n) · To do (n) · Graded (n). */
export function homeCounts(list: AssignmentSummary[] | null) {
  const out = { returned: 0, todo: 0, graded: 0 };
  for (const a of list ?? []) {
    const s = studentStatus(a);
    if (s === "returned") out.returned++;
    if (s === "returned" || s === "in_progress" || s === "not_started") out.todo++;
    if (s === "graded" && !a.read_only) out.graded++;
  }
  return out;
}
