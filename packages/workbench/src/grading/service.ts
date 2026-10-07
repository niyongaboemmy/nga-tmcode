import { create } from "zustand";
import { inExam } from "../exam/state";
import { getPlatform, notify, notifyProgress, openEditorInput, openFile, openPathFromOs, openRecent, useWorkbench } from "../state/store";
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
  grade: { score: number | null; rubric_scores: { index: number; score: number; comment?: string | null }[] | null; feedback: string | null; graded_at: string | null; ref_id: number | null } | null;
  submitted_at: string | null;
  late: boolean;
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
  };
  counts: { total: number; to_grade: number; graded: number };
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
}

export async function saveGrade(key: string, studentId: number, input: GradeInput): Promise<boolean> {
  const { type, id, question_id } = parseKey(key);
  try {
    const res = await api<{ ok: true; score: number; max_points: number }>("PUT", `/grading/${type}/${id}/students/${studentId}`, { ...input, question_id });
    await loadRoster(key, { quiet: true });
    notify("info", `Grade saved: ${res.score}/${res.max_points}. The student sees it in Task Mentor.`);
    return true;
  } catch (e) {
    notify("error", (e as Error).message);
    return false;
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
export async function openSubmission(key: string, row: RosterRow): Promise<boolean> {
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
    await openFolder(folder);
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
  set({ homeRoot: null });
  if (home) await openFolder(home);
  else applyReview(null);
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
