import { useExam } from "../exam/state";
import { useAssignments } from "../projects/assignments";
import { useProjects } from "../projects/service";
import type { Binding, Project } from "../projects/types";
import { useWorkbench } from "../state/store";
import { wireAiLive } from "./live";
import { forgetAiStatus, refreshAiStatus, setAiProject, useAi, type AiProject } from "./service";

/**
 * Keeps TMCode AI's idea of the open project (its Task Mentor id, and whether it is an assignment's
 * or quiz practical's workspace) in step with the projects view, and Task Mentor's AI status fresh:
 * - at once when the project changes, the student signs in, an exam starts or ends, or TMCode
 *   comes back to the front;
 * - when Task Mentor says the AI settings changed (ai/live.ts: the school's policy, a teacher's
 *   setting for the quiz or assignment, the roles), within seconds;
 * - every 15 s as a fallback, exams included (a line can drop; an older Task Mentor has none).
 */

export const AI_STATUS_REFRESH_MS = 15_000;

type AssignmentLists = { student: { my: { project_id: number | null } | null }[] | null };

/** The project the AI requests are about, from the folder's binding and what Task Mentor said of it. */
export function aiProjectOf(binding: Pick<Binding, "project_id" | "kind"> | null, current: Pick<Project, "id" | "assignment" | "links"> | null, assignments?: AssignmentLists): AiProject {
  if (!binding) return { id: null, assessment: false };
  const id = binding.project_id;
  const project = current?.id === id ? current : null;
  const links = project?.links;
  const linked = Array.isArray(links) ? links.length > 0 : (links?.total ?? 0) > 0;
  const forAssignment = !!assignments?.student?.some((a) => a.my?.project_id === id);
  return { id, assessment: !!project?.assignment || linked || forAssignment };
}

function current(): AiProject {
  const p = useProjects.getState();
  return aiProjectOf(p.binding, p.current, useAssignments.getState());
}

let wired = false;

const signedIn = () => !!useProjects.getState().account?.signed_in;

/** Asks for the status when it could matter: signed in, and TMCode on screen (the poll's case). */
function refreshIfUseful() {
  if (!signedIn()) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  void refreshAiStatus();
}

export function wireAiProject() {
  if (wired) return;
  wired = true;
  const sync = () => {
    const before = useAi.getState().project;
    const next = current();
    setAiProject(next);
    if (before.id !== next.id) refreshIfUseful();
  };
  sync();
  useProjects.subscribe((s, prev) => {
    if (s.binding !== prev.binding || s.current !== prev.current) sync();
    if (!!s.account?.signed_in !== !!prev.account?.signed_in) refreshIfUseful();
  });
  useAssignments.subscribe((s, prev) => {
    if (s.student !== prev.student) sync();
  });
  useWorkbench.subscribe((s, prev) => {
    if (s.policy.ai !== prev.policy.ai || s.policy.mode !== prev.policy.mode) refreshIfUseful();
  });
  useExam.subscribe((s, prev) => {
    if (!!s.quiz === !!prev.quiz) return;
    forgetAiStatus();
    refreshIfUseful();
  });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", refreshIfUseful);
  if (typeof window !== "undefined") window.addEventListener("focus", refreshIfUseful);
  setInterval(refreshIfUseful, AI_STATUS_REFRESH_MS);
  wireAiLive();
}

