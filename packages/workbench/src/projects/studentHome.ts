import { create } from "zustand";
import { inExam } from "../exam/state";
import { revealView, useWorkbench } from "../state/store";
import { SIGN_IN_EXPIRED, useAssignments, type AssignmentSummary } from "./assignments";
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

let wired = false;
export function wireStudentHome() {
  if (wired) return;
  wired = true;
  let prev = useProjects.getState().account;
  useProjects.subscribe((s) => {
    const acc = s.account;
    if (acc === prev) return;
    const was = prev;
    prev = acc;
    if (!acc) return;
    if (acc.signed_in) {
      intentional = false;
      if (useSession.getState().ended) useSession.setState({ ended: false });
      // The first successful sign-in on this computer: show where the work is.
      if (was && !was.signed_in && !readFlag() && !inExam() && useWorkbench.getState().policy.mode === "practice") {
        writeFlag();
        revealView("assignments");
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

/** What a student has to do now: how many, the next due date still ahead, and how many are overdue. */
export function todoOf(list: AssignmentSummary[] | null, now = Date.now()) {
  const todo = (list ?? []).filter((a) => !a.read_only && (!a.my || a.my.state === "not_started" || a.my.state === "in_progress"));
  const dues = todo.map((a) => (a.due_date ? Date.parse(a.due_date) : NaN)).filter((t) => !Number.isNaN(t));
  const ahead = dues.filter((t) => t >= now).sort((a, b) => a - b);
  return { count: todo.length, nextDue: ahead[0] ?? null, overdue: dues.length - ahead.length };
}

/** "2 to do · next due Fri", "1 to do · 1 overdue", "Nothing due". */
export function todoSummary(list: AssignmentSummary[] | null, now = Date.now()) {
  const { count, nextDue, overdue } = todoOf(list, now);
  if (count === 0) return "Nothing due";
  const parts = [`${count} to do`];
  if (nextDue !== null) parts.push(`next due ${dayLabel(nextDue, now)}`);
  else if (overdue > 0) parts.push(`${overdue} overdue`);
  return parts.join(" · ");
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
