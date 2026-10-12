import { activateEditor, focusGroup, notify, openEditorInput, useWorkbench } from "../state/store";
import { msg } from "../messages/catalog";
import { useAssignments, type AssignmentSummary } from "./assignments";
import { submitLink, useProjects } from "./service";
import { practicalStateOf, type PracticalState } from "./studentHome";
import { confirmSubmit, explainSubmitError, notifySubmitted } from "./submitFlow";
import type { Link, LinkableActivity, LinkItem, PracticalQuestion, Project } from "./types";

/**
 * Quiz practicals follow the assignments' path (workflow plan 6.3, W7): a
 * brief tab with the same one-status card, Start, Submit and Withdraw, so a
 * student never has to go through All My Projects to hand one in.
 */

export interface PracticalRef {
  quiz: LinkableActivity;
  q: PracticalQuestion;
}

export const practicalEditorId = (quizId: number, questionId: number) => `quiz:${quizId}:${questionId}`;

/** The quiz and question from the loaded Assignments list. */
export function findPractical(quizId: number, questionId: number): PracticalRef | null {
  const quiz = useAssignments.getState().quizPracticals?.find((x) => x.activity_id === quizId) ?? null;
  const q = quiz?.practical_questions?.find((x) => x.question_id === questionId) ?? null;
  return quiz && q ? { quiz, q } : null;
}

const linksOf = (p: Project | null): LinkItem[] => (!p ? [] : Array.isArray(p.links) ? (p.links as Link[]) : (p.links?.items ?? []));

/** This practical's link on a project (the one to submit). */
export function practicalLink(p: Project | null, quizId: number, questionId: number): Link | null {
  return (linksOf(p).find((l) => l.activity_type === "quiz" && l.activity_id === quizId && l.question_id === questionId) as Link | undefined) ?? null;
}

/** Where the student stands, and on which project: the payload's word when it has one, else their projects. */
export function practicalState(ref: PracticalRef, projects: Project[] | null, current: Project | null): { state: PracticalState; project: Project | null } {
  const found = practicalStateOf(ref.quiz.activity_id, ref.q.question_id, projects, current);
  return { state: ref.q.state ?? found.state, project: found.project };
}

/**
 * The practical as an assignment summary, so deriveStatus (projects/status.ts)
 * gives it the same one status and one button. Quiz practicals are never
 * "returned"; they close with the quiz.
 */
export function practicalSummary(ref: PracticalRef, state: PracticalState, project: Project | null): AssignmentSummary {
  const link = practicalLink(project, ref.quiz.activity_id, ref.q.question_id);
  return {
    id: -ref.q.question_id,
    title: ref.q.title,
    kind: "practical",
    course_id: ref.quiz.course_id ?? null,
    course_name: ref.quiz.course_name ?? null,
    status: "published",
    due_date: ref.quiz.due_date ?? null,
    points: ref.q.points,
    language: null,
    read_only: false,
    late: false,
    my: {
      project_id: project?.id ?? null,
      link_id: link?.id ?? null,
      state,
      submitted_at: link?.submitted_at ?? null,
      revision_number: link?.revision_number ?? null,
      grade: ref.q.grade ?? null,
      max_points: ref.q.points,
      feedback: null,
    },
    accepts_submissions: ref.quiz.open !== false,
  };
}

/** The practical's brief as an editor tab (one per question). */
export function showQuizPractical(quizId: number, questionId: number, opts: { toSide?: boolean } = {}) {
  const editorId = practicalEditorId(quizId, questionId);
  const s = useWorkbench.getState();
  const holder = s.groups.find((g) => g.editors.some((e) => e.id === editorId));
  if (holder) {
    const focused = s.activeGroup;
    activateEditor(holder.id, editorId);
    if (opts.toSide && focused !== holder.id) focusGroup(focused);
    return;
  }
  const title = findPractical(quizId, questionId)?.q.title ?? "Quiz practical";
  openEditorInput({ kind: "assignment", id: editorId, assignmentId: -questionId, title, preview: false, source: "quiz", quizId, questionId }, opts);
}

/** Submit from the brief: the same confirmation and words as assignments (projects/submitFlow.ts). */
export async function submitQuizPractical(quizId: number, questionId: number) {
  const ref = findPractical(quizId, questionId);
  const { binding, current } = useProjects.getState();
  const link = practicalLink(binding ? current : null, quizId, questionId);
  if (!ref || !current || !link) return notify("info", msg("submit.openPracticalFirst"));
  if (current.status === "submitted") return notify("info", msg("submit.already"));
  if (!(await confirmSubmit({ message: `Submit "${ref.q.title}"?`, late: !!ref.quiz.due_date && Date.parse(ref.quiz.due_date) < Date.now(), quizPractical: true }))) return;
  try {
    const res = await submitLink(current.id, link.id);
    notifySubmitted(`"${ref.q.title}"`, res.submission);
  } catch (e) {
    await explainSubmitError(e, { activity_type: "quiz", activity_id: quizId });
  } finally {
    const { recheck, refreshProjects } = await import("./service");
    await recheck();
    void refreshProjects();
    void import("./assignments").then((m) => m.refreshAssignments());
  }
}
