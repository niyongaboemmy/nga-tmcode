import { create } from "zustand";
import { useAssignments } from "../projects/assignments";
import { useGrading } from "../grading/service";
import { useProjects } from "../projects/service";
import { getPlatform, notify } from "./store";

/**
 * Who is using TMCode (workflow plan §3.1, W2): a student, a teacher, or a
 * teacher who also has student work ("both"). It comes from two network
 * answers (Task Mentor's teaching scope and the grading list); the last answer
 * is remembered per account, so the next launch starts in the right layout on
 * the first frame and is corrected when the network answers.
 */

export type Role = "unknown" | "student" | "teacher" | "both";

export interface RoleInputs {
  signedIn: boolean;
  /** Task Mentor answered the teaching scope (true), refused it (false) or hasn't said (null). */
  staff: boolean | null;
  /** The assignments check finished (answered or failed). */
  assignmentsChecked: boolean;
  /** The grading list was asked (answered or failed). */
  gradingChecked: boolean;
  grader: boolean;
  /** The account also has student assignments of its own. */
  studentWork: boolean;
  /** The role remembered from the last launch for this account. */
  cached: Role | null;
}

/** Pure: the role now, and whether the network has settled it (else `role` is the cached hint or "unknown"). */
export function resolveRole(i: RoleInputs): { role: Role; resolved: boolean } {
  if (!i.signedIn) return { role: "unknown", resolved: false };
  if (i.staff === true || i.grader) return { role: i.studentWork ? "both" : "teacher", resolved: true };
  // Teaching refused, or Task Mentor couldn't say (MIS down): once both checks are back, a student.
  if (i.assignmentsChecked && i.gradingChecked) return { role: "student", resolved: true };
  return { role: i.cached ?? "unknown", resolved: false };
}

export const isTeacherRole = (r: Role) => r === "teacher" || r === "both";

interface RoleState {
  role: Role;
  /** The network settled it (not just the remembered hint). */
  resolved: boolean;
  /** The remembered role of the signed-in account (null: none, or not loaded yet). */
  cached: Role | null;
}

export const useRole = create<RoleState>(() => ({ role: "unknown", resolved: false, cached: null }));

/** Teacher layout (Grading first, "Task Mentor Projects"). */
export const useIsTeacher = () => useRole((s) => isTeacherRole(s.role));
/** Signed in, and neither the network nor the last launch says who this is: "Checking your classes…". */
export function useRoleChecking() {
  const unknown = useRole((s) => s.role === "unknown");
  const signedIn = useProjects((s) => !!s.account?.signed_in);
  return unknown && signedIn;
}

const cacheKey = (id: number | string) => `role.${id}`;
const accountKey = () => {
  const u = useProjects.getState().account?.user;
  return u ? (u.id ?? u.email ?? null) : null;
};

function inputs(): RoleInputs {
  const a = useAssignments.getState();
  const g = useGrading.getState();
  return {
    signedIn: !!useProjects.getState().account?.signed_in,
    staff: a.staff,
    assignmentsChecked: a.checkedAt !== null,
    gradingChecked: g.activities !== null || g.error !== null,
    grader: g.grader,
    studentWork: (a.student?.length ?? 0) > 0,
    cached: useRole.getState().cached,
  };
}

let wired = false;
let loadedFor: number | string | null = null;
export function wireRole() {
  if (wired) return;
  wired = true;
  const update = () => {
    const key = accountKey();
    // A new account: its remembered role first (the first-frame hint), then the network.
    if (key !== loadedFor) {
      loadedFor = key;
      useRole.setState({ cached: null, role: "unknown", resolved: false });
      if (key !== null) {
        void getPlatform()
          .store.get<Role>(cacheKey(key))
          .then((cached) => {
            if (loadedFor !== key || !cached) return;
            useRole.setState({ cached });
            update();
          })
          .catch(() => {});
      }
    }
    const next = resolveRole(inputs());
    const s = useRole.getState();
    if (next.role === s.role && next.resolved === s.resolved) return;
    useRole.setState(next);
    if (next.resolved && key !== null && next.role !== s.cached) {
      // The network corrected the remembered layout: say so once.
      if (s.cached && isTeacherRole(s.cached) !== isTeacherRole(next.role)) {
        notify("info", `Your layout changed to ${isTeacherRole(next.role) ? "teacher" : "student"}.`, undefined, { kind: "hint" });
      }
      useRole.setState({ cached: next.role });
      void getPlatform().store.set(cacheKey(key), next.role).catch(() => {});
    }
  };
  update();
  useProjects.subscribe((s, prev) => s.account !== prev.account && update());
  useAssignments.subscribe((s, prev) => (s.staff !== prev.staff || s.checkedAt !== prev.checkedAt || s.student !== prev.student) && update());
  useGrading.subscribe((s, prev) => (s.grader !== prev.grader || s.activities !== prev.activities || s.error !== prev.error) && update());
}

/** Resolves once the network has said (or after `timeoutMs`, with whatever is known then). */
export function whenRoleResolved(timeoutMs = 4000): Promise<{ role: Role; resolved: boolean }> {
  const now = useRole.getState();
  if (now.resolved) return Promise.resolve({ role: now.role, resolved: true });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      const s = useRole.getState();
      resolve({ role: s.role, resolved: s.resolved });
    }, timeoutMs);
    const off = useRole.subscribe((s) => {
      if (!s.resolved) return;
      clearTimeout(timer);
      off();
      resolve({ role: s.role, resolved: true });
    });
  });
}
