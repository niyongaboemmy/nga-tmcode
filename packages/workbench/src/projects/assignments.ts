import { track } from "../state/activity";
import { create } from "zustand";
import { inExam } from "../exam/state";
import { activateEditor, focusGroup, getPlatform, notify, openEditorInput, openFile, revealView, showDialog, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { api, openProject, projectsSupported, refreshProjects, saveToTaskMentor, signIn, signedIn, submitLink, useProjects, TmError } from "./service";
import { explainSubmitError, notifySubmitted, submitConfirmDetail } from "./submitFlow";
import type { LinkableActivity, Project } from "./types";

/**
 * TMCode practicals (docs/ASSIGNMENTS_PLAN.md): Task Mentor assignments and
 * case studies with starter files. Students start their own workspace from
 * the starter, work, save and submit; a completed assignment is read-only.
 */

export type AssignmentState = "not_started" | "in_progress" | "submitted" | "graded";

export interface AssignmentSummary {
  id: number;
  title: string;
  kind: "practical" | "case_study";
  course_id: number | null;
  course_name: string | null;
  status: "published" | "completed";
  due_date: string | null;
  points: number | null;
  language: string | null;
  read_only: boolean;
  late: boolean;
  my: {
    project_id: number | null;
    link_id: number | null;
    state: AssignmentState;
    submitted_at: string | null;
    revision_number: number | null;
    grade: number | null;
    max_points: number | null;
    feedback: string | null;
    /** The hand-in was after the due date (servers that send it; else `late` is all there is). */
    is_late?: boolean | null;
    /** The teacher returned the work for changes: when, and their message. */
    returned_at?: string | null;
    returned_message?: string | null;
  } | null;
  teaching?: { students: number; started: number; submitted: number; graded: number };
}

export interface AssignmentDetail extends AssignmentSummary {
  description_html: string | null;
  instructions: string | null;
  attachments: { name: string; url: string }[];
  rubric: unknown;
  starter: { project_id: number; revision_id: number | null; file_count: number; size_bytes: number } | null;
}

interface AssignmentsState {
  student: AssignmentSummary[] | null;
  /** Quizzes of the student's subjects that have TMCode practical questions. */
  quizPracticals: LinkableActivity[] | null;
  teaching: AssignmentSummary[] | null;
  /** Task Mentor answered the teaching scope (staff) or refused it (students); null until asked. */
  staff: boolean | null;
  /** When the lists were last fetched (ms). */
  checkedAt: number | null;
  loading: boolean;
  error: string | null;
  /** "scope": Task Mentor couldn't say what the student has (MIS down, sign-in expired); the lists may be incomplete. */
  errorKind: "scope" | "unsupported" | null;
  details: Record<number, AssignmentDetail>;
  busy: Record<number, "starting" | "submitting" | undefined>;
}

export const useAssignments = create<AssignmentsState>(() => ({ student: null, quizPracticals: null, teaching: null, staff: null, checkedAt: null, loading: false, error: null, errorKind: null, details: {}, busy: {} }));
const set = useAssignments.setState;
const get = useAssignments.getState;

export function assignmentsSupported() {
  return projectsSupported() && signedIn();
}

export async function refreshAssignments() {
  if (!assignmentsSupported()) return;
  set({ loading: true });
  let staff: boolean | null = true;
  const [student, teaching, quizPracticals] = await Promise.allSettled([
    api<{ assignments: AssignmentSummary[] }>("GET", "/assignments?scope=student"),
    // Students are refused the teaching scope (403): that's an answer, not an error.
    api<{ assignments: AssignmentSummary[] }>("GET", "/assignments?scope=teaching").catch((e) => {
      if (e instanceof TmError && e.status === 403 && e.code !== "MIS_SCOPE_UNAVAILABLE") {
        staff = false;
        return { assignments: [] as AssignmentSummary[] };
      }
      throw e;
    }),
    // A failure here is shown too: an empty list would read as "no quiz practicals". (Refused: not for this account.)
    import("./matching")
      .then((m) => m.linkableActivities())
      .then((list) => list.filter((a) => a.activity_type === "quiz" && (a.practical_questions?.length ?? 0) > 0))
      .catch((e) => {
        if (e instanceof TmError && e.status === 403 && e.code !== "MIS_SCOPE_UNAVAILABLE") return [] as LinkableActivity[];
        throw e;
      }),
  ]);
  // What did load is kept (and what didn't keeps its last answer): the error says the lists may be incomplete.
  const s = get();
  const studentList = student.status === "fulfilled" ? student.value.assignments : s.student;
  // Compared with the previous snapshot (s.student): new work and new grades are announced.
  if (student.status === "fulfilled") announceChanges(s.student, student.value.assignments);
  const teachingList = teaching.status === "fulfilled" ? teaching.value.assignments : s.teaching;
  if (teaching.status === "rejected") staff = s.staff;
  // Open assignment pages follow the list (state, grade, completed → read-only).
  const details = { ...s.details };
  for (const a of [...(studentList ?? []), ...(teachingList ?? [])]) if (details[a.id]) details[a.id] = { ...details[a.id], ...a };
  const failed = [student, teaching, quizPracticals].find((r) => r.status === "rejected")?.reason as unknown;
  const unsupported = student.status === "rejected" && student.reason instanceof TmError && student.reason.status === 404;
  set({
    student: studentList,
    teaching: teachingList,
    quizPracticals: quizPracticals.status === "fulfilled" ? (quizPracticals.value as LinkableActivity[]) : s.quizPracticals,
    details,
    staff,
    checkedAt: Date.now(),
    loading: false,
    error: !failed ? null : unsupported ? "Your Task Mentor doesn't offer TMCode assignments yet." : scopeErrorDetail(failed),
    errorKind: !failed ? null : unsupported ? "unsupported" : "scope",
  });
}

/** The scope error when Task Mentor refuses the session (the view shows the session-ended banner). */
export const SIGN_IN_EXPIRED = "Your sign-in has expired.";

/**
 * What changed for the student since the last check (S9): new assignments and
 * new grades, as info toasts with a way to the brief. Never on the first load.
 */
const announced = new Set<string>();
export function announceChanges(before: AssignmentSummary[] | null, after: AssignmentSummary[]) {
  if (!before) return;
  const old = new Map(before.map((a) => [a.id, a]));
  // Two checks that overlap compare with the same snapshot: each change is told once.
  const once = (key: string) => !announced.has(key) && !!announced.add(key);
  for (const a of after) {
    const was = old.get(a.id);
    if (!was) {
      if (!a.read_only && once(`new:${a.id}`)) notify("info", `New assignment: ${a.title}`, [{ label: "Show Brief", run: () => showAssignment(a.id) }]);
      continue;
    }
    if (a.my?.state === "graded" && was.my?.state !== "graded" && once(`graded:${a.id}:${a.my.submitted_at ?? ""}:${a.my.grade ?? ""}`)) {
      const max = a.my.max_points ?? a.points;
      const score = a.my.grade != null ? `: ${a.my.grade}${max != null ? `/${max}` : ""}` : "";
      notify("info", `${a.title} was graded${score}`, [{ label: "View Feedback", run: () => showAssignment(a.id) }]);
    }
  }
}

/** Why Task Mentor couldn't say what the student has to do. */
function scopeErrorDetail(e: unknown) {
  if (e instanceof TmError && e.code === "MIS_SCOPE_UNAVAILABLE") return "Central MIS, which knows your subjects, can't be reached right now.";
  if (e instanceof TmError && e.status === 401) return SIGN_IN_EXPIRED;
  if (e instanceof TmError && e.status === 0) return "Task Mentor can't be reached. Check your internet connection.";
  return (e as Error)?.message || "Task Mentor didn't answer.";
}

/** Loaded on sign-in and kept fresh (the activity bar badge counts what is left to do). */
let wired = false;
export function wireAssignments() {
  if (wired) return;
  wired = true;
  let was = false;
  const follow = (signed: boolean) => {
    if (signed && !was) void refreshAssignments();
    if (!signed && was) set({ student: null, quizPracticals: null, teaching: null, staff: null, checkedAt: null, error: null, errorKind: null, details: {} });
    was = signed;
  };
  follow(signedIn());
  useProjects.subscribe((s) => follow(!!s.account?.signed_in));
  setInterval(() => signedIn() && void refreshAssignments(), 5 * 60_000);
  // Back from Task Mentor (where a teacher just published one): the list catches up.
  if (typeof window !== "undefined") window.addEventListener("focus", () => void refreshIfStale(20_000));
}

/** Refreshes unless the lists are fresher than `maxAgeMs` (opening the view, focusing the window). */
export function refreshIfStale(maxAgeMs = 30_000) {
  const { checkedAt, loading, errorKind } = get();
  if (!signedIn() || loading) return;
  // After a failure (back from signing in again, say), any check is worth it.
  if (checkedAt === null || errorKind === "scope" || Date.now() - checkedAt > maxAgeMs) return refreshAssignments();
}

export async function loadAssignment(id: number): Promise<AssignmentDetail | null> {
  try {
    const { assignment } = await api<{ assignment: AssignmentDetail }>("GET", `/assignments/${id}`);
    set({ details: { ...get().details, [id]: assignment } });
    return assignment;
  } catch (e) {
    notify("error", (e as Error).message);
    return null;
  }
}

/** The assignment page (brief, state, Start / Submit) as an editor tab. */
export function showAssignment(id: number, opts: { toSide?: boolean } = {}) {
  // One brief tab per assignment: if it is open in a group, bring it to the front there.
  const editorId = `assignment:${id}`;
  const s = useWorkbench.getState();
  const holder = s.groups.find((g) => g.editors.some((e) => e.id === editorId));
  if (holder) {
    const focused = s.activeGroup;
    activateEditor(holder.id, editorId);
    // Beside the code (opening a project): the code keeps the focus.
    if (opts.toSide && focused !== holder.id) focusGroup(focused);
    void loadAssignment(id);
    return;
  }
  const title = [...(get().student ?? []), ...(get().teaching ?? [])].find((a) => a.id === id)?.title ?? `Assignment ${id}`;
  openEditorInput({ kind: "assignment", id: `assignment:${id}`, assignmentId: id, title, preview: false }, opts);
  void loadAssignment(id);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "assignment";

function setBusy(id: number, b: "starting" | "submitting" | undefined) {
  set({ busy: { ...get().busy, [id]: b } });
}

/** Start (first time: Task Mentor copies the starter files into the student's own project) or continue. */
async function startAssignmentNow(id: number) {
  if (inExam()) return notify("info", "Finish your exam first.");
  setBusy(id, "starting");
  try {
    const { project, created } = await api<{ project: Project; created: boolean }>("POST", `/assignments/${id}/start`, {});
    const a = get().details[id] ?? (await loadAssignment(id));
    const folder = slug(`${a?.course_name ?? ""}-${a?.title ?? project.name}`);
    const opened = await openProject(project.id, { folderName: folder });
    if (!opened) return;
    showAssignment(id, { toSide: true });
    // No starter files from the teacher (and nothing written yet): offer a way to begin instead of an empty folder.
    const began = (await isEmptyWorkspace()) ? await offerStarter(a ?? null) : false;
    if (!began) await revealStarterFile();
    if (created && !began) notify("info", `Your workspace for "${a?.title ?? project.name}" is ready${a?.starter ? ` with ${a.starter.file_count} starter file${a.starter.file_count === 1 ? "" : "s"}` : ""}. Save to Task Mentor as you go, then Submit.`);
    void refreshAssignments();
    void refreshProjects();
  } catch (e) {
    if (e instanceof TmError && e.code === "ASSIGNMENT_COMPLETED") notify("info", "This assignment is completed and was not started.");
    else notify("error", (e as Error).message);
  } finally {
    setBusy(id, undefined);
  }
}

/** The open folder has no files of the student's yet (only TMCode's own .tmcode, .gitignore …). */
async function isEmptyWorkspace() {
  const entries = await getPlatform().fs.readDir("").catch(() => []);
  return !entries.some((e) => !e.name.startsWith("."));
}

/** Templates that fit an assignment's language ("html", "javascript", "python", "java" …), best first. */
export async function startersFor(language: string | null | undefined) {
  const { TEMPLATES } = await import("./templates");
  const lang = (language ?? "").toLowerCase();
  const web = /^(html|css|web|javascript|js)$/.test(lang);
  const fits = (t: (typeof TEMPLATES)[number]) => {
    const tl = t.language.toLowerCase();
    if (!lang) return false;
    if (web) return t.category === "Websites" || tl === "html" || (lang === "javascript" && tl === "javascript" && t.category === "Languages");
    return tl === lang || (lang === "c++" && tl === "cpp") || (lang === "c#" && tl === "csharp");
  };
  const matching = TEMPLATES.filter(fits);
  return matching.length ? matching : TEMPLATES.filter((t) => t.category === "Languages");
}

/**
 * An empty assignment workspace: pick how to begin (a template in the
 * assignment's language) or keep it empty. The files are saved to Task Mentor.
 */
async function offerStarter(a: AssignmentSummary | null): Promise<boolean> {
  const starters = await startersFor(a?.language);
  const pick = await showQuickPick({
    title: `Your project for "${a?.title ?? "this assignment"}" is empty. How do you want to begin?`,
    placeholder: "Choose starter files (you can change everything)",
    matchOnDescription: true,
    items: [
      ...starters.slice(0, 8).map((t, i) => ({ id: t.id, label: t.label, description: t.description, icon: t.icon, separator: i === 0 ? (a?.language ? `for ${a.language}` : "starters") : undefined })),
      { id: "__empty", label: "Start with an empty project", description: "Create the files yourself", icon: "new-file", pinLast: true, separator: "other" },
    ],
  });
  if (!pick || pick.id === "__empty") return false;
  const { templateById } = await import("./templates");
  const tpl = templateById(pick.id);
  if (!tpl) return false;
  const { writeTemplate, offerSetup } = await import("./commands");
  focusCodeGroup();
  await writeTemplate(tpl);
  await saveToTaskMentor({ message: `Started from the ${tpl.label} template`, quiet: true });
  notify("info", `Your project starts from the ${tpl.label} template and is saved to Task Mentor. Save as you go, then Submit.`);
  await offerSetup(tpl);
  return true;
}

/** The editor group for code: not the one holding briefs (focused, so new files open there). */
function focusCodeGroup() {
  const groups = useWorkbench.getState().groups;
  const code = groups.find((g) => !g.editors.some((e) => e.kind === "assignment")) ?? groups[0];
  if (code) focusGroup(code.id);
}

/** Opens the file to begin with (README, index.html, main.*), as the plan's "reveal the first file". */
async function revealStarterFile() {
  // The brief beside the code doesn't count: a file the student already has open does.
  if (useWorkbench.getState().groups.some((g) => g.editors.some((e) => e.kind === "file"))) return;
  focusCodeGroup();
  const entries = await getPlatform().fs.readDir("").catch(() => []);
  const files = entries.filter((e) => e.kind === "file").map((e) => e.path);
  const pick =
    files.find((f) => /^readme\.md$/i.test(f)) ??
    files.find((f) => /^index\.html?$/i.test(f)) ??
    files.find((f) => /^(main|app|index)\.\w+$/i.test(f)) ??
    files.find((f) => !f.startsWith("."));
  if (pick) openFile(pick, { pinned: true });
}

/** Is the open folder this assignment's workspace? */
export function isOpenWorkspaceOf(a: AssignmentSummary) {
  const b = useProjects.getState().binding;
  return !!b && !!a.my?.project_id && b.project_id === a.my.project_id;
}

export async function submitAssignment(id: number) {
  const a = get().details[id] ?? [...(get().student ?? [])].find((x) => x.id === id);
  if (!a?.my?.project_id || !a.my.link_id) return notify("info", "Start the assignment first.");
  if (a.read_only) return notify("info", "This assignment is completed: it can no longer be submitted.");
  if (!isOpenWorkspaceOf(a)) {
    notify("info", "Open your workspace for this assignment first (Continue), so the newest work is what you submit.");
    return;
  }
  const choice = await showDialog({
    severity: "info",
    message: `Submit "${a.title}"?`,
    detail: submitConfirmDetail({ late: !!a.due_date && Date.parse(a.due_date) < Date.now() }),
    buttons: [
      { id: "submit", label: "Save and Submit", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "submit") return;
  setBusy(id, "submitting");
  try {
    // submitLink saves first, and refuses while there are unsaved changes or conflicts.
    const res = await submitLink(a.my.project_id, a.my.link_id);
    notifySubmitted(`"${a.title}"`, res.submission);
    await Promise.all([refreshAssignments(), loadAssignment(id)]);
  } catch (e) {
    await explainSubmitError(e);
  } finally {
    setBusy(id, undefined);
  }
}

/** Teachers: publish the open project (saved to Task Mentor) as an assignment's starter files. */
export async function publishAsStarter() {
  const b = useProjects.getState().binding;
  if (!b || b.kind !== "tm") return notify("info", "Open a Task Mentor project (not a GitHub one) to use it as starter files.");
  await saveToTaskMentor({ quiet: true });
  await refreshAssignments();
  const list = get().teaching ?? [];
  const pick = await showQuickPick({
    placeholder: `Use "${b.name}" as the starter files of…`,
    matchOnDescription: true,
    items: list.map((a) => ({ id: String(a.id), label: a.title, description: `${a.course_name ?? ""} · ${a.kind === "case_study" ? "case study" : "practical"}`, icon: "mortar-board" })),
  });
  if (!pick) return;
  const a = list.find((x) => String(x.id) === pick.id)!;
  try {
    await api("PUT", `/assignments/${a.id}/tmcode`, { kind: a.kind ?? "practical", language: a.language, starter_project_id: b.project_id, starter_revision_id: null, instructions: get().details[a.id]?.instructions ?? null });
    notify("info", `"${b.name}" is now the starter of "${a.title}". Students who start it get the latest saved version.`);
    void refreshAssignments();
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

/** `tmcode://assignment?id=12&api=…` from Task Mentor's "Open in TMCode". */
export function parseAssignmentLink(link: string): { id: number; api: string } | null {
  try {
    const u = new URL(link);
    if (u.protocol !== "tmcode:" || (u.hostname !== "assignment" && u.pathname.replace(/^\/+/, "") !== "assignment")) return null;
    const id = Number(u.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return null;
    return { id, api: (u.searchParams.get("api") ?? "").replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

export async function openAssignmentLink(link: { id: number; api: string }) {
  const { isAllowedApi } = await import("../exam/api");
  if (!isAllowedApi(link.api, !!getPlatform().exam?.dev)) return notify("error", "This link points to an unknown Task Mentor server and was ignored.");
  if (inExam()) return notify("info", "Finish your exam first.");
  const account = useProjects.getState().account;
  if (account?.signed_in && link.api && account.tm_api.replace(/\/+$/, "") !== link.api) {
    return notify("error", `This assignment belongs to ${link.api}, but TMCode is signed in to ${account.tm_api}.`);
  }
  revealView("assignments");
  if (!signedIn()) {
    // Open it as soon as the browser sign-in completes.
    const off = useProjects.subscribe((s) => {
      if (!s.account?.signed_in) return;
      off();
      void refreshAssignments().then(() => showAssignment(link.id));
    });
    setTimeout(off, 10 * 60_000);
    notify("info", "Sign in with NGA to open this assignment.");
    void signIn();
    return;
  }
  await refreshAssignments();
  showAssignment(link.id);
}

/** "3 days left", "due in 5 h", "2 days late". */
export function dueLabel(due: string | null, now = Date.now()): { text: string; tone: "ok" | "soon" | "late" } | null {
  if (!due) return null;
  const ms = new Date(due).getTime() - now;
  const abs = Math.abs(ms);
  const h = abs / 3_600_000;
  const amount = h < 1 ? `${Math.max(1, Math.round(abs / 60_000))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
  if (ms < 0) return { text: `${amount} late`, tone: "late" };
  return { text: `${amount} left`, tone: h < 24 ? "soon" : "ok" };
}

/** Was the hand-in late? `my.is_late` when Task Mentor sends it; older servers only say the due date has passed. */
export function handedInLate(a: AssignmentSummary): boolean {
  const v = a.my?.is_late;
  return v === undefined ? a.late : !!v;
}

/** The teacher returned the work for changes, and it isn't handed in again yet. */
export function returnedForChanges(a: AssignmentSummary): boolean {
  return !!a.my?.returned_at && a.my.state === "in_progress" && !a.read_only;
}

/** Assignments grouped for the view. */
export function groupAssignments(list: AssignmentSummary[]) {
  const groups = { todo: [] as AssignmentSummary[], submitted: [] as AssignmentSummary[], graded: [] as AssignmentSummary[], completed: [] as AssignmentSummary[] };
  for (const a of list) {
    if (a.read_only) groups.completed.push(a);
    else if (a.my?.state === "graded") groups.graded.push(a);
    else if (a.my?.state === "submitted") groups.submitted.push(a);
    else groups.todo.push(a);
  }
  const byDue = (x: AssignmentSummary, y: AssignmentSummary) => (x.due_date ? Date.parse(x.due_date) : Infinity) - (y.due_date ? Date.parse(y.due_date) : Infinity);
  groups.todo.sort(byDue);
  return groups;
}

/** startAssignment, shown as activity from its first step: "Preparing your workspace…". */
export const startAssignment = (...args: Parameters<typeof startAssignmentNow>) => track("Preparing your workspace…", () => startAssignmentNow(...args));
