import { track } from "../state/activity";
import { create } from "zustand";
import { inExam } from "../exam/state";
import { confirmLeaveWorkspace, getPlatform, notify, notifyProgress, openEditorInput, openFile, openPathFromOs, openRecent, useWorkbench } from "../state/store";
import { api, projectsSupported, signedIn, TmError, useProjects } from "../projects/service";
import { linkableActivities } from "../projects/matching";
import type { Manifest } from "../projects/plan";

/**
 * Grading TMCode practicals in TMCode (teachers): the assignments and quiz
 * practical questions of their subjects, each one's submissions with progress,
 * the student's submitted version loaded as a read-only review folder, and
 * criteria grades saved to Task Mentor (GET/PUT /api/tmcode/grading/…).
 */

export type ActivityType = "assignment" | "quiz";

export interface Criterion {
  criteria: string;
  description: string | null;
  max_score: number;
  /** Named levels ("Excellent" = 12…), when the rubric has them: they become the quick scores. */
  levels?: { label: string; score: number }[] | null;
}

/** A teacher's comment on one line of the submitted code. */
export interface Annotation {
  path: string;
  line: number;
  text: string;
}

export interface RowGrade {
  score: number | null;
  rubric_scores: { index: number; score: number; comment?: string | null }[] | null;
  feedback: string | null;
  graded_at: string | null;
  ref_id: number | null;
  /** Newer Task Mentor (older ones omit these fields). */
  annotations?: Annotation[] | null;
  /** false: a draft the student doesn't see yet (or nothing graded); missing means released. */
  released?: boolean;
  /** Task Mentor 0.12: "ungraded" (a row with no grade yet still has one, for its version), "draft", "released". */
  status?: "ungraded" | "draft" | "released";
  /** What the student sees while a draft is pending (null: nothing released). */
  released_score?: number | null;
  graded_by?: { id: number; name: string } | null;
  /** Opaque; changes on every save (sent back as if_version). */
  version?: string;
}

/** A version the student saved: `revision` is its number (or id, see diff.ts). */
export interface RevisionRef {
  revision: number;
  at: string;
  id?: number;
}

/** One gradable thing: an assignment, or one practical question of a quiz. */
export interface Gradable {
  key: string;
  type: ActivityType;
  id: number;
  question_id: number | null;
  title: string;
  /** Quiz practicals: the question; the quiz is `title`. */
  question_title: string | null;
  course_name: string | null;
  due_date: string | null;
  status: string | null;
  max_points: number | null;
}

export type RowState = "submitted" | "graded" | "in_progress" | "not_started";

export interface RosterRow {
  student: { id: number; name: string; avatar_url?: string | null; email?: string | null } | null;
  state: RowState;
  project: { id: number; name: string; status?: string; kind: "tm" | "github"; language: string | null; repo_url: string | null } | null;
  link: { id: number; status: string; submitted_at: string | null; revision_id: number | null; revision_number: number | null; git_commit: string | null } | null;
  grade: RowGrade | null;
  submitted_at: string | null;
  late: boolean;
  /** The starter files' version: a revision number of the student's project, or another project's revision. */
  starter_revision?: number | { project_id: number; revision_id: number } | null;
  /** The versions the student saved. */
  revisions?: RevisionRef[] | null;
}

export interface Roster {
  activity: {
    type: ActivityType;
    id: number;
    title: string;
    course_id: number | null;
    due_date: string | null;
    max_points: number;
    rubric: Criterion[];
    question: { id: number; text: string; instructions: string } | null;
    questions: { question_id: number; title: string; points: number }[];
    can_grade: boolean;
    /** Task Mentor 0.12: whether "Return for changes" works here (false for quiz practicals). */
    can_return?: boolean;
  };
  counts: { total: number; to_grade: number; graded: number; drafts?: number };
  rows: RosterRow[];
  loadedAt: number;
}

interface GradingState {
  /** null until loaded; [] for someone with nothing to grade. */
  activities: Gradable[] | null;
  /** Whether the signed-in user grades at all (the Grading view shows for them). */
  grader: boolean;
  loading: boolean;
  error: string | null;
  rosters: Record<string, Roster>;
  rosterErrors: Record<string, string>;
  /** The open grading tab's selected student, per activity. */
  selected: Record<string, number>;
  /** The review folder open now (a student's submitted version). */
  review: Review | null;
  /** Where the teacher was before the first review, to go back. */
  homeRoot: string | null;
  loadingReview: string | null;
}

export interface Review {
  key: string;
  project_id: number;
  revision_id: number;
  student: string;
  student_id: number;
  activity: string;
}

export const useGrading = create<GradingState>(() => ({
  activities: null,
  grader: false,
  loading: false,
  error: null,
  rosters: {},
  rosterErrors: {},
  selected: {},
  review: null,
  homeRoot: null,
  loadingReview: null,
}));
const set = useGrading.setState;
const get = useGrading.getState;

export const keyOf = (type: ActivityType, id: number, questionId: number | null) => `${type}:${id}:${questionId ?? ""}`;
export function parseKey(key: string): { type: ActivityType; id: number; question_id: number | null } {
  const [type, id, q] = key.split(":");
  return { type: type as ActivityType, id: Number(id), question_id: q ? Number(q) : null };
}

const REVIEW_FILE = ".tmcode/review.json";
const REVIEWS_KEY = "grading.reviews";

// ── The list of gradable activities ───────────────────────────────────────

interface ListedActivity {
  type: ActivityType;
  id: number;
  title: string;
  course_name?: string | null;
  due_date?: string | null;
  status?: string | null;
  max_points?: number | null;
  questions?: { question_id: number; title: string; points: number }[] | null;
}

function toGradables(list: ListedActivity[]): Gradable[] {
  const out: Gradable[] = [];
  for (const a of list) {
    if (a.type === "quiz") {
      for (const q of a.questions ?? []) {
        out.push({ key: keyOf("quiz", a.id, q.question_id), type: "quiz", id: a.id, question_id: q.question_id, title: a.title, question_title: q.title, course_name: a.course_name ?? null, due_date: a.due_date ?? null, status: a.status ?? null, max_points: q.points });
      }
    } else {
      out.push({ key: keyOf("assignment", a.id, null), type: "assignment", id: a.id, question_id: null, title: a.title, question_title: null, course_name: a.course_name ?? null, due_date: a.due_date ?? null, status: a.status ?? null, max_points: a.max_points ?? null });
    }
  }
  return out;
}

/**
 * GET /grading lists them (Task Mentor ≥ 2026-10-07 evening); before that,
 * the teaching assignments plus the quizzes with practical questions.
 */
async function listGradable(): Promise<{ grader: boolean; list: Gradable[] }> {
  try {
    const res = await api<{ activities: ListedActivity[] }>("GET", "/grading");
    return { grader: true, list: toGradables(res.activities ?? []) };
  } catch (e) {
    if (e instanceof TmError && e.status === 403) return { grader: false, list: [] };
    if (!(e instanceof TmError && e.status === 404)) throw e;
  }
  let teaching: { id: number; title: string; course_name: string | null; due_date: string | null; status: string; points: number | null }[];
  try {
    teaching = (await api<{ assignments: typeof teaching }>("GET", "/assignments?scope=teaching")).assignments ?? [];
  } catch (e) {
    if (e instanceof TmError && (e.status === 403 || e.status === 404)) return { grader: false, list: [] };
    throw e;
  }
  const quizzes = await linkableActivities().catch(() => []);
  return {
    grader: true,
    list: toGradables([
      ...teaching.map((a) => ({ type: "assignment" as const, id: a.id, title: a.title, course_name: a.course_name, due_date: a.due_date, status: a.status, max_points: a.points })),
      ...quizzes
        .filter((q) => q.activity_type === "quiz" && (q.practical_questions?.length ?? 0) > 0)
        .map((q) => ({ type: "quiz" as const, id: q.activity_id, title: q.title, course_name: q.course_name, due_date: q.due_date, status: "published", questions: q.practical_questions })),
    ]),
  };
}

export function gradingSupported() {
  return projectsSupported() && signedIn();
}

export async function refreshGrading(opts: { rosters?: boolean } = { rosters: true }) {
  if (!gradingSupported()) return;
  set({ loading: true, error: null });
  try {
    const { grader, list } = await listGradable();
    set({ activities: list, grader, loading: false });
    // Progress for every activity, a few at a time.
    if (opts.rosters !== false && grader) {
      const queue = [...list];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) await loadRoster(a.key, { quiet: true });
      };
      await Promise.all([worker(), worker(), worker()]);
    }
  } catch (e) {
    set({ loading: false, error: (e as Error).message });
  }
}

export async function loadRoster(key: string, opts: { quiet?: boolean } = {}): Promise<Roster | null> {
  const { type, id, question_id } = parseKey(key);
  try {
    const res = await api<Omit<Roster, "loadedAt">>("GET", `/grading/${type}/${id}${question_id ? `?question_id=${question_id}` : ""}`);
    const roster = { ...res, loadedAt: Date.now() };
    const errors = { ...get().rosterErrors };
    delete errors[key];
    set({ rosters: { ...get().rosters, [key]: roster }, rosterErrors: errors });
    return roster;
  } catch (e) {
    set({ rosterErrors: { ...get().rosterErrors, [key]: (e as Error).message } });
    if (!opts.quiet) notify("error", (e as Error).message);
    return null;
  }
}

/** Progress of one activity: graded of handed in, and of everyone with work. */
export function progressOf(r: Roster | undefined) {
  if (!r) return null;
  const submitted = r.counts.to_grade + r.counts.graded;
  const inProgress = r.rows.filter((x) => x.state === "in_progress").length;
  return { graded: r.counts.graded, toGrade: r.counts.to_grade, submitted, inProgress, total: r.counts.total, pct: submitted ? Math.round((r.counts.graded / submitted) * 100) : 0 };
}

// ── Opening a grading tab ─────────────────────────────────────────────────

export function openGrading(key: string, opts: { toSide?: boolean } = {}) {
  const a = get().activities?.find((x) => x.key === key);
  const title = a ? `Grade: ${a.question_title ?? a.title}` : "Grading";
  openEditorInput({ kind: "grading", id: `grading:${key}`, gradingKey: key, title, preview: false }, opts);
  if (!get().rosters[key]) void loadRoster(key);
}

export function selectStudent(key: string, studentId: number) {
  set({ selected: { ...get().selected, [key]: studentId } });
}

// ── Saving a grade ────────────────────────────────────────────────────────

export interface GradeInput {
  rubric_scores: { index: number; score: number; comment?: string | null }[];
  score?: number | null;
  feedback: string;
  annotations?: Annotation[];
}

export type SaveResult =
  | { ok: true; score: number; max_points: number; released: boolean; locksStudent: boolean }
  /** `conflict`: another teacher saved first (409 GRADE_CHANGED); their grade. `code`: Task Mentor's error code. */
  | { ok: false; error: string; conflict?: RowGrade; code?: string };

export interface SaveOptions {
  /** false: a draft grade the student doesn't see yet (Task Mentor ≥ 0.12). */
  release: boolean;
  /** The version this grade was edited from: a newer one on the server answers 409. */
  ifVersion?: string | null;
  /** No toast (bulk release says one thing at the end). */
  quiet?: boolean;
}

/** Does this Task Mentor keep draft grades? true / false once a grade says so, null before any grade. */
export function draftsSupported(r: Roster | undefined): boolean | null {
  const graded = r?.rows.filter((x) => x.grade) ?? [];
  if (!graded.length) return null;
  return graded.some((x) => x.grade && "released" in x.grade);
}

/** A grade the student can't see yet. */
export const isDraftGrade = (row: RosterRow) => !!row.grade && (row.grade.status ? row.grade.status === "draft" : row.grade.released === false);

function savedMessage(type: ActivityType, score: number, max: number, released: boolean, draftsKnown: boolean) {
  if (!released) {
    return draftsKnown
      ? { severity: "info" as const, text: `Draft saved: ${score}/${max}. The student doesn't see it until you release it.` }
      : { severity: "warning" as const, text: `Grade saved: ${score}/${max}. This Task Mentor has no draft grades yet, so the student can already see it.` };
  }
  return { severity: "info" as const, text: type === "quiz" ? `Grade saved: ${score}/${max}. The student sees it when the quiz results are released.` : `Grade saved: ${score}/${max}. The student sees it in Task Mentor.` };
}

async function saveGradeNow(key: string, studentId: number, input: GradeInput, opts: SaveOptions = { release: true }): Promise<SaveResult> {
  const { type, id, question_id } = parseKey(key);
  try {
    const body: Record<string, unknown> = { ...input, question_id, release: opts.release };
    if (opts.ifVersion) body.if_version = opts.ifVersion;
    const res = await api<{ ok: true; score: number; max_points: number; released?: boolean; locks_student?: boolean }>("PUT", `/grading/${type}/${id}/students/${studentId}`, body);
    const roster = await loadRoster(key, { quiet: true });
    const row = roster?.rows.find((r) => r.student?.id === studentId);
    // Older servers ignore `release`: they answer no `released`, their grades carry none, and they are live.
    const known = typeof res.released === "boolean" || (!!row?.grade && "released" in row.grade);
    const released = typeof res.released === "boolean" ? res.released : opts.release || !known || row?.grade?.released !== false;
    const locksStudent = res.locks_student === true;
    if (!opts.quiet) {
      const m = savedMessage(type, res.score, res.max_points, released, known);
      notify(m.severity, locksStudent ? `${m.text} The student's project is now read-only.` : m.text);
    }
    return { ok: true, score: res.score, max_points: res.max_points, released, locksStudent };
  } catch (e) {
    if (e instanceof TmError && e.status === 409 && e.code === "GRADE_CHANGED") {
      void loadRoster(key, { quiet: true });
      return { ok: false, code: e.code, error: "Another teacher saved a grade while you were editing.", conflict: (e.body.grade as RowGrade | undefined) ?? undefined };
    }
    if (e instanceof TmError && e.code === "DRAFT_NEEDS_SUBMISSION") {
      return { ok: false, code: e.code, error: "This student hasn't handed in yet: you can only release a grade, not save a draft." };
    }
    return { ok: false, code: e instanceof TmError ? e.code : undefined, error: (e as Error).message || "Task Mentor could not be reached." };
  }
}

/**
 * "Release N Drafts": every draft grade of the activity becomes visible to its
 * student (POST /grading/:type/:id/release; one PUT per draft on older servers).
 */
export async function releaseDrafts(key: string, toInput: (roster: Roster, row: RosterRow) => GradeInput): Promise<void> {
  const roster = get().rosters[key] ?? (await loadRoster(key));
  if (!roster) return;
  const rows = roster.rows.filter(isDraftGrade);
  if (!rows.length) {
    notify("info", "There are no draft grades to release.");
    return;
  }
  const { type, id, question_id } = parseKey(key);
  const nameOf = (sid: number) => roster.rows.find((r) => r.student?.id === sid)?.student?.name ?? "A student";
  const why = (code: string) => (code === "GRADE_CHANGED" ? "changed by another teacher" : code === "DRAFT_NEEDS_SUBMISSION" ? "not handed in yet" : code.toLowerCase().replace(/_/g, " "));
  let done = 0;
  let locked = 0;
  const failed: string[] = [];
  try {
    const res = await api<{ released: number; student_ids: number[]; skipped: { student_id: number; code: string }[]; locked_students?: number | number[] }>("POST", `/grading/${type}/${id}/release`, question_id ? { question_id } : {});
    done = res.released ?? res.student_ids?.length ?? 0;
    locked = Array.isArray(res.locked_students) ? res.locked_students.length : (res.locked_students ?? 0);
    for (const sk of res.skipped ?? []) failed.push(`${nameOf(sk.student_id)}: ${why(sk.code)}`);
  } catch (e) {
    if (!(e instanceof TmError && e.status === 404)) {
      notify("error", `Could not release the drafts: ${(e as Error).message}`);
      return;
    }
    // Older Task Mentor: one save per draft.
    for (const row of rows) {
      const r = await saveGradeNow(key, row.student!.id, toInput(roster, row), { release: true, ifVersion: row.grade?.version, quiet: true });
      if (r.ok) {
        done++;
        if (r.locksStudent) locked++;
      } else failed.push(`${row.student?.name ?? "A student"}: ${r.conflict ? "changed by another teacher" : r.error}`);
    }
  }
  await loadRoster(key, { quiet: true });
  const what = type === "quiz" ? " Students see them when the quiz results are released." : " Students see them in Task Mentor now.";
  const locks = locked ? ` ${locked === 1 ? "1 student's project is" : `${locked} students' projects are`} now read-only.` : "";
  if (failed.length) notify("warning", `Released ${done} of ${done + failed.length} grades. Not released: ${failed.join("; ")}.${locks}`);
  else notify("info", `Released ${done} grade${done === 1 ? "" : "s"}.${what}${locks}`);
}

/**
 * "Return for changes" (assignments): the submitted project goes back to the
 * student as a draft, with the teacher's message. Same endpoint as Task
 * Mentor's web grading page (POST /projects/:id/return).
 */
export async function returnForChanges(key: string, row: RosterRow, message: string, allowResubmission = false): Promise<{ ok: true } | { ok: false; error: string; unsupported?: boolean; canAllowResubmission?: boolean }> {
  if (!row.project) return { ok: false, error: "There is no project to return." };
  try {
    await api("POST", `/projects/${row.project.id}/return`, { message: message.trim() || null, ...(allowResubmission ? { allow_resubmission: true } : {}) });
    await loadRoster(key, { quiet: true });
    notify("info", allowResubmission ? `${row.student?.name ?? "The student"} can change their work and submit again. Their grade was taken back.` : `Returned to ${row.student?.name ?? "the student"} for changes. They can edit and submit again.`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TmError && e.code === "RETURN_NOT_SUPPORTED") return { ok: false, unsupported: true, error: "Quiz practicals can't be returned for changes. Grade the answer as it is." };
    if (e instanceof TmError && e.code === "PROJECT_GRADED") {
      return e.body.allow_resubmission === true
        ? { ok: false, canAllowResubmission: true, error: "This work is already graded. Allow Resubmission takes the grade back so the student can change it and submit again." }
        : { ok: false, error: "This work is already graded, so it can't be returned." };
    }
    if (e instanceof TmError && e.code === "NOT_SUBMITTED") return { ok: false, error: "This work isn't submitted any more (the student may have withdrawn it)." };
    return { ok: false, error: (e as Error).message };
  }
}

// ── A student's submitted version, as a read-only review folder ───────────

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "review";

async function readReviewFile(): Promise<Review | null> {
  if (!useWorkbench.getState().workspace) return null;
  try {
    return JSON.parse(await getPlatform().fs.readFile(REVIEW_FILE)) as Review;
  } catch {
    return null;
  }
}

let readOnlyByReview = false;
function applyReview(review: Review | null) {
  set({ review });
  if (inExam()) return;
  if (review) {
    readOnlyByReview = true;
    useWorkbench.setState({ readOnly: true, readOnlyReason: `Reviewing ${review.student}'s submission for "${review.activity}" (read-only).` });
  } else if (readOnlyByReview) {
    readOnlyByReview = false;
    useWorkbench.setState({ readOnly: false, readOnlyReason: null });
  }
}

/** The file to show first: README, index.html, main.* or the first file. */
async function revealEntry() {
  if (useWorkbench.getState().groups[0]?.editors.some((e) => e.kind === "file")) return;
  const entries = await getPlatform().fs.readDir("").catch(() => []);
  const files = entries.filter((e) => e.kind === "file").map((e) => e.path);
  const pick =
    files.find((f) => /^readme\.md$/i.test(f)) ?? files.find((f) => /^index\.html?$/i.test(f)) ?? files.find((f) => /^(main|app|index)\.\w+$/i.test(f)) ?? files.find((f) => !f.startsWith("."));
  if (pick) openFile(pick, { pinned: true, group: 0 });
}

const openFolder = (path: string) => (getPlatform().openPath ? openPathFromOs(path) : openRecent(path));

/**
 * Loads the student's submitted version (the frozen revision) into its own
 * folder, opens it read-only with the grading tab beside it.
 */
async function openSubmissionNow(key: string, row: RosterRow): Promise<boolean> {
  const host = getPlatform().account;
  if (!host || !row.project || !row.student) return false;
  if (row.project.kind === "github") {
    notify("info", `${row.student.name} works on GitHub: open the repository${row.link?.git_commit ? ` at ${row.link.git_commit.slice(0, 7)}` : ""} from the grading panel.`);
    return false;
  }
  const revId = row.link?.revision_id;
  if (!revId) {
    notify("info", `${row.student.name} hasn't submitted yet: there is no version to review.`);
    return false;
  }
  if (get().review?.project_id === row.project.id && get().review?.revision_id === revId) return true;
  const a = get().activities?.find((x) => x.key === key);
  const activity = a?.question_title ?? a?.title ?? get().rosters[key]?.activity.title ?? "the activity";
  const review: Review = { key, project_id: row.project.id, revision_id: revId, student: row.student.name, student_id: row.student.id, activity };
  // Unsaved files first (Cancel keeps the teacher's folder), not halfway through the download.
  if (!(await confirmLeaveWorkspace())) return false;
  const ws = useWorkbench.getState().workspace;
  if (ws && !get().review && !get().homeRoot) set({ homeRoot: ws.root });
  set({ loadingReview: `${row.project.id}@${revId}` });
  const progress = notifyProgress(`Loading ${row.student.name}'s submission…`);
  try {
    const store = getPlatform().store;
    const folders = (await store.get<Record<string, string>>(REVIEWS_KEY)) ?? {};
    const known = folders[`${row.project.id}@${revId}`];
    if (known) {
      await openFolder(known).catch(() => {});
      const there = await readReviewFile();
      if (useWorkbench.getState().workspace?.root === known && there?.revision_id === revId) {
        applyReview(there);
        await afterOpen(key);
        return true;
      }
    }
    const { files } = await api<{ files: Manifest }>("GET", `/projects/${row.project.id}/revisions/${revId}/manifest`);
    const folder = await host.newFolder(slug(`review-${row.student.name}-${activity}-v${row.link?.revision_number ?? revId}`));
    // Kept the current folder: the submission's files must not be written into it.
    if (!(await openFolder(folder))) return false;
    let done = 0;
    for (const f of files) {
      const res = await api<{ base64: string }>("GET", `/projects/${row.project.id}/blobs/${f.sha256}`, undefined, { response: "base64" });
      await host.writeBlob(f.path, f.sha256, res.base64);
      progress.update({ message: `Loading ${f.path}…`, progress: Math.round((++done / Math.max(1, files.length)) * 100) });
    }
    const fs = getPlatform().fs;
    await fs.createDir(".tmcode").catch(() => {});
    await fs.writeFile(REVIEW_FILE, JSON.stringify(review, null, 2)).catch(async () => {
      await fs.createFile(REVIEW_FILE);
      await fs.writeFile(REVIEW_FILE, JSON.stringify(review, null, 2));
    });
    await store.set(REVIEWS_KEY, { ...folders, [`${row.project.id}@${revId}`]: folder });
    // The explorer lists what was just written.
    const { applyExternalChanges } = await import("../monaco/external");
    await applyExternalChanges(files.map((f) => f.path));
    applyReview(review);
    await afterOpen(key);
    return true;
  } catch (e) {
    notify("error", `Could not load the submission: ${(e as Error).message}`);
    return false;
  } finally {
    progress.close();
    set({ loadingReview: null });
  }
}

async function afterOpen(key: string) {
  await revealEntry();
  openGrading(key, { toSide: true });
}

/** Back to the folder the teacher had open before reviewing. */
export async function closeReview() {
  const home = get().homeRoot;
  const key = get().review?.key;
  if (home) {
    // Kept the review open (Cancel on unsaved files): try again later.
    if (!(await openFolder(home))) return;
    set({ homeRoot: null });
  } else applyReview(null);
  if (key) openGrading(key, { toSide: false });
}

/** A short-lived page of the submitted website (Task Mentor serves it), in the built-in browser. */
export async function previewSubmission(row: RosterRow) {
  if (!row.project || !row.link?.revision_id) return;
  try {
    const { url } = await api<{ url: string }>("POST", `/projects/${row.project.id}/preview`, { rev: row.link.revision_id });
    const { openBrowser } = await import("../terminal/browser");
    openBrowser(url, { toSide: true });
  } catch (e) {
    notify(e instanceof TmError && e.code === "NO_HTML" ? "info" : "error", (e as Error).message);
  }
}

/** Follows the account and the open folder (a review folder is read-only). */
let wired = false;
export function wireGrading() {
  if (wired) return;
  wired = true;
  void import("./commands").then((m) => m.registerGradingCommands());
  void import("./comments").then((m) => m.wireReviewComments());
  let was = false;
  const follow = (signed: boolean) => {
    if (signed && !was) void refreshGrading({ rosters: true });
    if (!signed && was) set({ activities: null, grader: false, rosters: {}, review: null });
    was = signed;
  };
  follow(signedIn());
  useProjects.subscribe((s) => follow(!!s.account?.signed_in));
  let root = useWorkbench.getState().workspace?.root;
  const check = async () => applyReview(await readReviewFile());
  void check();
  useWorkbench.subscribe((s) => {
    if (s.workspace?.root === root) return;
    root = s.workspace?.root;
    void check();
  });
}

/** openSubmission, shown as activity from its first step: "Opening the student's project…". */
export const openSubmission = (...args: Parameters<typeof openSubmissionNow>) => track("Opening the student's project…", () => openSubmissionNow(...args));

/** saveGrade, shown as activity from its first step: "Saving the grade…". */
export const saveGrade = (...args: Parameters<typeof saveGradeNow>) => track("Saving the grade…", () => saveGradeNow(...args));
