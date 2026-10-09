import { create } from "zustand";
import { inExam } from "../exam/state";
import { getPlatform, notify, openEditorInput, openFile, revealView, showDialog, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { api, openProject, projectsSupported, refreshProjects, saveToTaskMentor, signIn, signedIn, submitLink, useProjects, TmError } from "./service";
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
  details: Record<number, AssignmentDetail>;
  busy: Record<number, "starting" | "submitting" | undefined>;
}

export const useAssignments = create<AssignmentsState>(() => ({ student: null, quizPracticals: null, teaching: null, staff: null, checkedAt: null, loading: false, error: null, details: {}, busy: {} }));
const set = useAssignments.setState;
const get = useAssignments.getState;

export function assignmentsSupported() {
  return projectsSupported() && signedIn();
}

export async function refreshAssignments() {
  if (!assignmentsSupported()) return;
  set({ loading: true, error: null });
  try {
    let staff = true;
    const [student, teaching, quizPracticals] = await Promise.all([
      api<{ assignments: AssignmentSummary[] }>("GET", "/assignments?scope=student"),
      // Students are refused the teaching scope (403): that's an answer, not an error.
      api<{ assignments: AssignmentSummary[] }>("GET", "/assignments?scope=teaching").catch((e) => {
        if (e instanceof TmError && e.status === 403) {
          staff = false;
          return { assignments: [] as AssignmentSummary[] };
        }
        throw e;
      }),
      import("./matching").then((m) => m.linkableActivities()).then((list) => list.filter((a) => a.activity_type === "quiz" && (a.practical_questions?.length ?? 0) > 0)).catch(() => [] as LinkableActivity[]),
    ]);
    // Open assignment pages follow the list (state, grade, completed → read-only).
    const details = { ...get().details };
    for (const a of [...student.assignments, ...teaching.assignments]) if (details[a.id]) details[a.id] = { ...details[a.id], ...a };
    set({ student: student.assignments, teaching: teaching.assignments, quizPracticals, details, staff, checkedAt: Date.now(), loading: false });
  } catch (e) {
    set({ loading: false, checkedAt: Date.now(), error: e instanceof TmError && e.status === 404 ? "Your Task Mentor doesn't offer TMCode assignments yet." : `Couldn't load your assignments: ${(e as Error).message}` });
  }
}

/** Loaded on sign-in and kept fresh (the activity bar badge counts what is left to do). */
let wired = false;
export function wireAssignments() {
  if (wired) return;
  wired = true;
  let was = false;
  const follow = (signed: boolean) => {
    if (signed && !was) void refreshAssignments();
    if (!signed && was) set({ student: null, quizPracticals: null, teaching: null, staff: null, checkedAt: null, details: {} });
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
  const { checkedAt, loading } = get();
  if (!signedIn() || loading) return;
  if (checkedAt === null || Date.now() - checkedAt > maxAgeMs) return refreshAssignments();
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
export async function startAssignment(id: number) {
  if (inExam()) return notify("info", "Finish your exam first.");
  setBusy(id, "starting");
  try {
    const { project, created } = await api<{ project: Project; created: boolean }>("POST", `/assignments/${id}/start`, {});
    const a = get().details[id] ?? (await loadAssignment(id));
    const folder = slug(`${a?.course_name ?? ""}-${a?.title ?? project.name}`);
    const opened = await openProject(project.id, { folderName: folder });
    if (!opened) return;
    await revealStarterFile();
    showAssignment(id, { toSide: true });
    if (created) notify("info", `Your workspace for "${a?.title ?? project.name}" is ready${a?.starter ? ` with ${a.starter.file_count} starter file${a.starter.file_count === 1 ? "" : "s"}` : ""}. Save to Task Mentor as you go, then Submit.`);
    void refreshAssignments();
    void refreshProjects();
  } catch (e) {
    if (e instanceof TmError && e.code === "ASSIGNMENT_COMPLETED") notify("info", "This assignment is completed and was not started.");
    else notify("error", (e as Error).message);
  } finally {
    setBusy(id, undefined);
  }
}

/** Opens the file to begin with (README, index.html, main.*), as the plan's "reveal the first file". */
async function revealStarterFile() {
  if (useWorkbench.getState().groups.some((g) => g.editors.length > 0)) return;
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
    detail: `TMCode saves your work to Task Mentor, then submits that exact version${a.late ? ". The due date has passed: it will be marked late" : ""}. You can submit again until the assignment is completed.`,
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
    const late = (res.submission as { is_late?: boolean } | null)?.is_late;
    notify("info", `Submitted "${a.title}"${late ? " (late)" : ""}. Your teacher sees exactly this version.`);
    await Promise.all([refreshAssignments(), loadAssignment(id)]);
  } catch (e) {
    notify("error", (e as Error).message);
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

