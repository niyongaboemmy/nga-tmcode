import { track } from "../state/activity";
import { notify, showDialog } from "../state/store";
import { showQuickPick, type PickItem } from "../widgets/QuickPick";
import { api, openProject, recheck as checkSync, refreshProjects, submitLink, TmError, useProjects } from "./service";
import type { Link, LinkableActivity, PracticalQuestion, Project } from "./types";

/**
 * Matching a project with a Task Mentor assessment (an assignment, a quiz or a
 * recorded assessment): pick a subject, then the kind of assessment, then the
 * assessment. A project can also stay unmatched (a personal project).
 */

export type ActivityType = Link["activity_type"];

export const TYPE_LABEL: Record<ActivityType, { one: string; many: string; icon: string }> = {
  assignment: { one: "Assignment", many: "Assignments", icon: "notebook" },
  quiz: { one: "Quiz", many: "Quizzes", icon: "checklist" },
  manual_assessment: { one: "Recorded assessment", many: "Recorded assessments", icon: "graph" },
};

/** Task Mentor answers `{type, id}`; older mocks and docs used `{activity_type, activity_id}`. */
export function normalizeActivity(raw: Record<string, unknown>): LinkableActivity | null {
  const type = (raw.activity_type ?? raw.type) as ActivityType | undefined;
  const id = Number(raw.activity_id ?? raw.id);
  if (!type || !(type in TYPE_LABEL) || !Number.isInteger(id) || id <= 0) return null;
  return {
    activity_type: type,
    activity_id: id,
    title: String(raw.title ?? `${TYPE_LABEL[type].one} ${id}`),
    course_id: (raw.course_id as number | null | undefined) ?? null,
    course_name: (raw.course_name as string | null | undefined) ?? null,
    due_date: (raw.due_date as string | null | undefined) ?? null,
    open: raw.open === undefined ? true : !!raw.open,
    practical_questions: Array.isArray(raw.practical_questions)
      ? (raw.practical_questions as Record<string, unknown>[])
          .map((q) => ({ question_id: Number(q.question_id), title: String(q.title ?? "TMCode practical"), points: Number(q.points ?? 0) }))
          .filter((q) => Number.isInteger(q.question_id) && q.question_id > 0)
      : [],
  };
}

export async function linkableActivities(): Promise<LinkableActivity[]> {
  const res = await api<{ activities: Record<string, unknown>[] }>("GET", "/activities/linkable");
  return (res.activities ?? []).map(normalizeActivity).filter((a): a is LinkableActivity => !!a);
}

const subjectOf = (a: LinkableActivity) => a.course_name ?? "Other";
const NONE = "__none";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "due 10 Oct · 2 days left", "closed", "overdue by 3 days". */
export function dueText(iso: string | null | undefined, open = true): string {
  if (!open) return "closed";
  if (!iso) return "";
  const t = Date.parse(iso);
  const day = new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
  const days = Math.round((t - Date.now()) / 86_400_000);
  if (t < Date.now()) return `was due ${day}`;
  return `due ${day} · ${days <= 0 ? "today" : days === 1 ? "tomorrow" : `${days} days left`}`;
}

/** An assessment, and for a quiz optionally one of its TMCode practical questions. */
export type Picked = LinkableActivity & { question?: PracticalQuestion };
export type Pick = Picked | "none";

/** One searchable list: every assessment (and each quiz's practical questions), by subject, soonest due first. */
export function assessmentItems(list: LinkableActivity[], current?: { activity_type: ActivityType; activity_id: number; question_id?: number | null } | null): PickItem[] {
  const bySubject = new Map<string, LinkableActivity[]>();
  for (const a of list) bySubject.set(subjectOf(a), [...(bySubject.get(subjectOf(a)) ?? []), a]);
  const dueAt = (a: LinkableActivity) => (a.open === false ? Infinity : a.due_date ? Date.parse(a.due_date) : Number.MAX_SAFE_INTEGER);
  const items: PickItem[] = [];
  for (const [subject, acts] of [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let first = true;
    for (const a of [...acts].sort((x, y) => dueAt(x) - dueAt(y) || x.title.localeCompare(y.title))) {
      const isCurrent = (q?: number) => !!current && current.activity_type === a.activity_type && current.activity_id === a.activity_id && (current.question_id ?? null) === (q ?? null);
      const when = dueText(a.due_date, a.open !== false);
      // A quiz's TMCode practical questions come first: that is what a project is usually for.
      for (const q of a.activity_type === "quiz" ? (a.practical_questions ?? []) : []) {
        items.push({
          id: `${a.activity_type}:${a.activity_id}:${q.question_id}`,
          label: q.title,
          icon: "beaker",
          description: [`Quiz practical · ${a.title}`, plural(q.points, "point", "points"), subject, isCurrent(q.question_id) ? "current" : ""].filter(Boolean).join(" · "),
          detail: when || undefined,
          separator: first ? subject : undefined,
        });
        first = false;
      }
      items.push({
        id: `${a.activity_type}:${a.activity_id}`,
        label: a.title,
        icon: TYPE_LABEL[a.activity_type].icon,
        description: [a.activity_type === "quiz" && a.practical_questions?.length ? "Whole quiz" : TYPE_LABEL[a.activity_type].one, subject, isCurrent() ? "current" : ""].filter(Boolean).join(" · "),
        detail: when || undefined,
        separator: first ? subject : undefined,
      });
      first = false;
    }
  }
  return items;
}

/**
 * Which assessment is this project for: one list to search by title or
 * subject. Resolves to the activity (with the practical question for a quiz
 * practical), to "none" (no assessment, when `allowNone`), or undefined when cancelled.
 */
export async function pickAssessment(opts: { title: string; allowNone?: boolean; noneLabel?: string; current?: { activity_type: ActivityType; activity_id: number; question_id?: number | null } | null } = { title: "Match with an assessment" }): Promise<Pick | undefined> {
  let all: LinkableActivity[] = [];
  try {
    const items = linkableActivities().then((list) => {
      all = list;
      const rows = assessmentItems(list, opts.current);
      if (list.length === 0) rows.push({ id: "__empty", label: "No open assessments in your subjects", icon: "info", alwaysShow: true, description: "Ask your teacher to publish one" });
      // Last, so Enter never makes it a personal project by accident.
      if (opts.allowNone) rows.push({ id: NONE, label: opts.noneLabel ?? "No assessment (a personal project)", icon: "circle-slash", pinLast: true, description: "You can match it later", separator: "other" });
      return rows;
    });
    const pick = await showQuickPick({ title: opts.title, placeholder: "Search assessments by title or subject", items, matchOnDescription: true });
    if (!pick || pick.id === "__empty") return undefined;
    if (pick.id === NONE) return "none";
    const [type, id, qid] = pick.id.split(":");
    const act = all.find((a) => a.activity_type === type && String(a.activity_id) === id);
    if (!act) return undefined;
    const question = qid ? act.practical_questions?.find((q) => String(q.question_id) === qid) : undefined;
    return question ? { ...act, question } : act;
  } catch (e) {
    notify("error", `Could not load your assessments: ${(e as Error).message}`);
    return undefined;
  }
}

/** The open project's links, as GET /projects/:id lists them. */
export function currentLinks(): Link[] {
  const p = useProjects.getState().current;
  return Array.isArray(p?.links) ? (p!.links as Link[]) : [];
}

/** Links a project to an activity; ALREADY_LINKED from another project is explained. */
export async function linkProject(projectId: number, a: Picked): Promise<Link | null> {
  try {
    const { link } = await api<{ link: Link }>("POST", `/projects/${projectId}/links`, { activity_type: a.activity_type, activity_id: a.activity_id, ...(a.question ? { question_id: a.question.question_id } : {}) });
    return link;
  } catch (e) {
    if (e instanceof TmError && e.code === "ALREADY_LINKED") {
      notify("warning", `"${a.question?.title ?? a.title}" is already matched with another of your projects. Unmatch it there first (Projects › Change Assessment…).`);
      return null;
    }
    throw e;
  }
}

/**
 * Change (or remove) the open project's assessment: the old link goes, the new
 * one comes. If the new one is refused, the old one is put back.
 */
export async function changeAssessment() {
  const { binding, current } = useProjects.getState();
  if (!binding || !current) return notify("info", "Open a Task Mentor project first.");
  if (current.status === "submitted" || current.status === "graded") {
    return notify("info", current.status === "graded" ? "This project is graded: its assessment can't change." : "Withdraw the submission first (Projects › Withdraw Submission); then you can change its assessment.");
  }
  const links = currentLinks();
  const submitted = links.find((l) => l.status === "submitted");
  if (submitted) return notify("info", `This project was submitted to "${submitted.activity?.title ?? "an activity"}". Withdraw the submission first.`);
  const old = links[0] ?? null;
  const picked = await pickAssessment({
    title: old ? "Change the assessment" : "Match with an assessment",
    allowNone: !!old,
    noneLabel: "Remove the match (keep it as a personal project)",
    current: old ? { activity_type: old.activity_type, activity_id: old.activity_id, question_id: old.question_id ?? null } : null,
  });
  if (!picked) return;
  if (picked !== "none" && old && old.activity_type === picked.activity_type && old.activity_id === picked.activity_id && (old.question_id ?? null) === (picked.question?.question_id ?? null)) return notify("info", "That is already this project's assessment.");
  try {
    for (const l of links) await api("DELETE", `/projects/${current.id}/links/${l.id}`);
    if (picked === "none") {
      notify("info", `${current.name} is no longer matched with an assessment.`);
    } else {
      const link = await linkProject(current.id, picked).catch(async (e) => {
        if (old) await api("POST", `/projects/${current.id}/links`, { activity_type: old.activity_type, activity_id: old.activity_id, ...(old.question_id ? { question_id: old.question_id } : {}) }).catch(() => {});
        throw e;
      });
      if (!link) {
        if (old) await api("POST", `/projects/${current.id}/links`, { activity_type: old.activity_type, activity_id: old.activity_id, ...(old.question_id ? { question_id: old.question_id } : {}) }).catch(() => {});
        return;
      }
      notify("info", `${current.name} is now for "${picked.question?.title ?? picked.title}"${picked.course_name ? ` (${picked.course_name})` : ""}. Submit it when your work is ready.`);
    }
  } catch (e) {
    notify("error", (e as Error).message);
  } finally {
    await checkSync();
    void refreshProjects();
  }
}

/**
 * Project → Submitted: saves, then hands the work in for its assessment
 * (POST /projects/:id/submit for an assignment, the link's submit otherwise).
 * An unmatched project is matched first.
 */
export async function submitProject() {
  const { binding, current } = useProjects.getState();
  if (!binding || !current) return notify("info", "Open a Task Mentor project first.");
  if (current.status === "submitted") return notify("info", "This project is already submitted. Withdraw the submission to change it.");
  if (current.status === "graded") return notify("info", "This project is already graded.");
  if (current.read_only) return notify("info", "This assignment is completed: it can no longer be submitted.");
  let links = currentLinks();
  if (links.length === 0) {
    const ok = await showDialog({
      severity: "info",
      message: "Match this project with an assessment first",
      detail: "Submitting hands your work in for an assignment, a quiz or a recorded assessment. Choose which one.",
      buttons: [
        { id: "match", label: "Choose an Assessment…", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (ok !== "match") return;
    const picked = await pickAssessment({ title: "Submit for" });
    if (!picked || picked === "none") return;
    const link = await linkProject(current.id, picked);
    if (!link) return;
    await checkSync();
    links = currentLinks();
  }
  const target = links.find((l) => l.activity_type === "assignment") ?? links[0];
  const title = target.activity?.title ?? TYPE_LABEL[target.activity_type].one;
  const choice = await showDialog({
    severity: "info",
    message: `Submit "${current.name}" for "${title}"?`,
    detail:
      "TMCode saves your work to Task Mentor, then submits that exact version. The project is then Submitted and locked: withdraw the submission if you need to change it before it is graded." +
      (target.activity_type === "quiz" && target.question_id ? "\n\nThis is a quiz practical: keep the quiz open in Task Mentor while you submit, so your project is recorded as your answer." : ""),
    buttons: [
      { id: "submit", label: "Save and Submit", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "submit") return;
  try {
    const res = await submitLink(current.id, target.id);
    const late = (res.submission as { is_late?: boolean } | null)?.is_late;
    notify("info", `Submitted "${current.name}" for "${title}"${late ? " (late)" : ""}. Your teacher sees exactly this version.`);
  } catch (e) {
    notify("error", (e as Error).message);
  } finally {
    await checkSync();
    void refreshProjects();
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "practical";

/**
 * Starts a quiz's TMCode practical question: Task Mentor creates the student's
 * project from the question's starter files and links it (idempotent: later
 * starts open the same project).
 */
async function startQuizPracticalNow(quiz: { activity_id: number; title: string; course_name?: string | null }, q: PracticalQuestion) {
  try {
    const { project, created } = await api<{ project: Project; link_id: number; created: boolean }>("POST", `/quizzes/${quiz.activity_id}/questions/${q.question_id}/start`, {});
    const opened = await openProject(project.id, { folderName: slug(`${quiz.title}-${q.title}`) });
    if (!opened) return false;
    notify(
      "info",
      created
        ? `Your workspace for "${q.title}" is ready${project.head ? " with the starter files" : ""}. Keep the quiz "${quiz.title}" open in Task Mentor, then Submit Project when you finish.`
        : `Opened your work for "${q.title}".`,
    );
    void refreshProjects();
    return true;
  } catch (e) {
    if (e instanceof TmError && e.code === "ACTIVITY_CLOSED") notify("info", `"${quiz.title}" is closed: its practical can't be started.`);
    else notify("error", (e as Error).message);
    return false;
  }
}

/** startQuizPractical, shown as activity from its first step: "Preparing your workspace…". */
export const startQuizPractical = (...args: Parameters<typeof startQuizPracticalNow>) => track("Preparing your workspace…", () => startQuizPracticalNow(...args));
