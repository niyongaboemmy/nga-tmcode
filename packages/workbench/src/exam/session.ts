import { chainHmac, filesHash, journalKey, type ExamPackage, type Profile } from "@tmcode/protocol";
import { onDocumentChanged, saveAll } from "../monaco/documents";
import { onRunStarted } from "../run/runService";
import { loadTests, setServerRunner, setVisibleTests, useServerRun } from "../run/testService";
import type { ExamHost, JournalEntry, Toolchain } from "../platform/types";
import { getPlatform, log, notify, onWorkspaceChanged, openFile, refreshExplorer, revealView, saveDirtyFiles, setPolicy, setTests, setWorkspace, showDialog, updateTest, useWorkbench } from "../state/store";
import { PRACTICE_POLICY } from "@tmcode/protocol";
import { ALLOWED_APIS, ApiError, TmApi, isAllowedApi, verdictLabel, type SessionGrant } from "./api";
import { clockCheck, diskCheck, problemCount, reachabilityCheck, toolchainChecks, type CheckItem } from "./readiness";
import { isExamRoot } from "./roots";
import { ServerClock, formatRemaining } from "./clock";
import { initialExamState, useExam, type ExamTaskState, type LockReason } from "./state";
import { resetCopies } from "./pasteGuard";

/**
 * One exam attempt (plan §5.1, §13): launch → package → task folders →
 * snapshots into a local, tamper-evident journal → background sync →
 * heartbeat/deadline → submit → results. Works offline once started.
 */

// A few seconds after a save, so "All work saved" is never far behind the editor.
const SNAPSHOT_EVERY_MS = 3_000;
const HEARTBEAT_MS = 10_000;
const set = useExam.setState;
const get = useExam.getState;

let api: TmApi | null = null;
let host: ExamHost | null = null;
let key: Uint8Array | null = null;
let journal: JournalEntry[] = [];
let lastHmac = "";
const clock = new ServerClock();
const timers: ReturnType<typeof setInterval>[] = [];
const dirtyTasks = new Map<number, ReturnType<typeof setTimeout>>();
let unsubscribeDocs: (() => void) | null = null;
let unsubscribeRuns: (() => void) | null = null;
let syncRun: Promise<void> | null = null;
let syncBackoff = 1000;
/** Set when Task Mentor refused the journal for good (no point retrying). */
let syncStopped = false;
let warned = new Set<number>();

export function examClock() {
  return clock;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "task";

function taskOfPath(path: string): ExamTaskState | undefined {
  return get().tasks.find((t) => path === t.folder || path.startsWith(`${t.folder}/`));
}

// ───────────────────────── start ─────────────────────────

/** Parses `tmcode://launch?t=…&api=…`. */
export function parseLaunchLink(link: string): { ticket: string; api: string } | null {
  try {
    const u = new URL(link);
    const ticket = u.searchParams.get("t");
    const apiBase = u.searchParams.get("api");
    if (u.protocol !== "tmcode:" || !ticket || !apiBase) return null;
    return { ticket, api: apiBase };
  } catch {
    return null;
  }
}

export async function startExam(apiBase: string, ticket: string) {
  const platform = getPlatform();
  host = platform.exam ?? null;
  if (!host) return notify("error", "Exams can't be taken here. Open the link in the TMCode desktop app.");
  if (get().phase === "active" || get().phase === "starting") {
    const choice = await showDialog({
      message: "You are already in an exam.",
      detail: "Opening another exam link will leave the current one. Your work stays saved.",
      buttons: [
        { id: "switch", label: "Open the new exam", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
      severity: "warning",
    });
    if (choice !== "switch") return;
    stopExam();
  }
  lastLaunch = { api: apiBase, ticket, grant: null };
  if (!isAllowedApi(apiBase, host.dev)) {
    set({ ...initialExamState, phase: "error", errorCode: "UNKNOWN_SERVER", error: `It points to an unknown server (${apiBase}).` });
    return;
  }
  await launch(apiBase, ticket, null);
}

/** The last launch link (and its session, once redeemed), for Try Again. */
let lastLaunch: { api: string; ticket: string; grant: SessionGrant | null } | null = null;

/** Try Again on the error card: reuses the session if the ticket was already redeemed (a ticket works once). */
export function retryLaunch() {
  if (!lastLaunch) return;
  const { api: base, ticket, grant } = lastLaunch;
  void launch(base, ticket, grant);
}

async function launch(apiBase: string, ticket: string, reuse: SessionGrant | null) {
  if (!host) return;
  set({ ...initialExamState, phase: "starting" });
  api = new TmApi(apiBase, (u, i) => host!.fetch(u, i));
  try {
    const device = await host.device();
    let grant = reuse;
    if (grant) {
      api.token = grant.token;
      api.sid = grant.session_id;
    } else {
      const toolchains = await host.toolchains().catch(() => []);
      grant = await api.redeem(ticket, device, { toolchains });
      if (lastLaunch) lastLaunch.grant = grant;
    }
    const t0 = Date.now();
    const pkg = await api.examPackage(device.app_version);
    const packageMs = Date.now() - t0;
    clock.sync(pkg.server_time);
    key = await journalKey(pkg.journal_nonce, grant.session_id);
    journal = await host.journal.load(grant.session_id);
    lastHmac = journal.length ? journal[journal.length - 1].hmac : "";
    syncStopped = false;
    resetCopies();
    const earlier = await earlierJournals(pkg.submission_id, grant.session_id);
    const replay = await prepareWorkspace(pkg, grant.session_id, earlier);
    // The system check (E1): problems hold the exam in the lobby until the student chooses Start the Exam.
    if (!(await lobby(pkg, packageMs))) return;
    await rememberInProgress(pkg, apiBase);
    set({
      phase: "active",
      quiz: pkg.quiz,
      submissionId: pkg.submission_id,
      sessionId: grant.session_id,
      deadline: Date.parse(pkg.deadline),
      sync: { pending: journal.filter((j) => !j.synced).length, queued: 0, offline: false, lastSyncedAt: null, tampered: false },
    });
    setPolicy(pkg.policy);
    wire();
    focusTask(get().tasks[0]?.question_id ?? null);
    revealView("task");
    log("Exam", `Started "${pkg.quiz.title}" (submission ${pkg.submission_id}, session ${grant.session_id})`);
    // Work from an earlier session that never reached Task Mentor goes into this session's journal.
    for (const qid of replay) void snapshot(qid, "auto");
    void sync();
  } catch (e) {
    // The error card maps the code to a plain title and actions (launchErrors.ts); raw text only as detail.
    if (e instanceof ApiError) {
      log("Exam", `Launch failed: ${e.code} ${e.message}`, "error");
      set({ phase: "error", errorCode: e.code, errorData: e.data, error: e.message, readiness: null });
    } else {
      const msg = String((e as Error)?.message ?? e);
      log("Exam", `Launch failed: ${msg}`, "error");
      const zod = (e as Error)?.name === "ZodError";
      set({ phase: "error", errorCode: zod ? "APP_TOO_OLD" : e instanceof WorkspaceError ? "WORKSPACE_DIRTY" : null, errorData: {}, error: zod ? "" : msg, readiness: null });
    }
  }
}

class WorkspaceError extends Error {}

// ───────────────────────── system check (lobby) ─────────────────────────

let lobbyAnswer: ((start: boolean) => void) | null = null;

/** Runs the checks for this exam's languages; resolves false if the student left the lobby. */
async function lobby(pkg: ExamPackage, packageMs: number): Promise<boolean> {
  const p = getPlatform();
  const used = [...new Set(pkg.tasks.map((t) => t.profile_id))].map((id) => pkg.profiles.find((x) => x.id === id)).filter((x): x is Profile => !!x);
  const endsAt = Date.parse(pkg.deadline);
  for (;;) {
    set({ readiness: { items: [], waiting: false, endsAt } });
    const [found, disk] = await Promise.all([p.runner ? p.runner.detect(true).catch(() => [] as Toolchain[]) : Promise.resolve([] as Toolchain[]), diskCheck("workspace")]);
    const items: CheckItem[] = [
      ...(p.runner ? toolchainChecks(used, found, p.os, { exam: true }) : []),
      reachabilityCheck({ ms: packageMs }),
      clockCheck(Date.parse(pkg.server_time) + packageMs / 2 - Date.now(), p.os),
      disk,
    ];
    log("Exam", `System check: ${items.map((i) => `${i.label} ${i.status}`).join(", ")}`);
    if (!problemCount(items)) {
      set({ readiness: { items, waiting: false, endsAt } });
      return true;
    }
    set({ readiness: { items, waiting: true, endsAt } });
    const answer = await new Promise<"start" | "again" | "leave">((resolve) => {
      lobbyAnswer = (start) => resolve(start ? "start" : "again");
      lobbyLeave = () => resolve("leave");
    });
    lobbyAnswer = null;
    lobbyLeave = null;
    if (answer === "start") return true;
    if (answer === "leave") return false;
  }
}

let lobbyLeave: (() => void) | null = null;

/** Lobby buttons: Start the Exam (true) or Check Again (false). */
export function answerLobby(start: boolean) {
  lobbyAnswer?.(start);
}

// ───────────────────────── exam in progress on this computer (E3) ─────────────────────────

const IN_PROGRESS_KEY = "exam.inProgress";
const SUBMITTED_KEY = "exam.submittedRoots";

interface InProgress {
  submission_id: number;
  title: string;
  deadline: string;
  grace_minutes: number;
  api: string;
  root: string | null;
}

async function rememberInProgress(pkg: ExamPackage, apiBase: string) {
  const rec: InProgress = {
    submission_id: pkg.submission_id,
    title: pkg.quiz.title,
    deadline: pkg.deadline,
    grace_minutes: pkg.policy.allow_offline_grace_minutes ?? 0,
    api: apiBase,
    root: useWorkbench.getState().workspace?.root ?? null,
  };
  await getPlatform().store.set(IN_PROGRESS_KEY, rec).catch(() => {});
}

async function forgetInProgress(submitted: boolean) {
  const store = getPlatform().store;
  const rec = await store.get<InProgress>(IN_PROGRESS_KEY).catch(() => undefined);
  await store.set(IN_PROGRESS_KEY, null).catch(() => {});
  const root = rec?.root ?? useWorkbench.getState().workspace?.root ?? null;
  if (submitted && root) {
    const roots = (await store.get<string[]>(SUBMITTED_KEY).catch(() => undefined)) ?? [];
    if (!roots.includes(root)) await store.set(SUBMITTED_KEY, [...roots, root].slice(-50)).catch(() => {});
    submittedRoots.add(root);
  }
}

const submittedRoots = new Set<string>();

/**
 * At startup: "You have an exam in progress" when an exam on this computer
 * was neither submitted nor ended. It only reopens through Task Mentor (a new
 * launch link), never from Recent.
 */
export async function checkExamInProgress() {
  const store = getPlatform().store;
  for (const r of (await store.get<string[]>(SUBMITTED_KEY).catch(() => undefined)) ?? []) submittedRoots.add(r);
  guardExamFolder();
  const rec = await store.get<InProgress>(IN_PROGRESS_KEY).catch(() => undefined);
  if (!rec || get().phase !== "idle") return;
  if (Date.parse(rec.deadline) + rec.grace_minutes * 60_000 < Date.now()) {
    await store.set(IN_PROGRESS_KEY, null).catch(() => {});
    return;
  }
  notify("warning", `You have an exam in progress: "${rec.title}". Reopen it from Task Mentor (Open in TMCode). Your work is saved.`, [
    { label: "Open Task Mentor", run: () => openTaskMentorFor(rec.api, "/quizzes") },
  ]);
}

/** Task Mentor's web app for an API base (as projects/commands taskMentorWeb). */
function taskMentorWeb(api: string) {
  if (/^https:\/\/taskmentor-api\./.test(api)) return api.replace("://taskmentor-api.", "://taskmentor.");
  return "http://localhost:5173/taskmentor";
}

/** Opens a Task Mentor web page for an API base (the exam's server). */
export function openTaskMentorFor(apiBase: string | null, path = "/quizzes") {
  const url = `${taskMentorWeb(apiBase ?? ALLOWED_APIS[0])}${path}`;
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function openExamTaskMentor() {
  openTaskMentorFor(lastLaunch && host && isAllowedApi(lastLaunch.api, host.dev) ? lastLaunch.api : null);
}

let guardedRoot: string | null = null;

/**
 * An exam folder open outside an exam (after Close exam, or opened by hand):
 * read-only, terminal off. Submitted work can't change, and unsubmitted work
 * only continues through Task Mentor (with the timer and the journal).
 */
export function guardExamFolder() {
  const root = useWorkbench.getState().workspace?.root ?? null;
  const phase = get().phase;
  const outside = phase === "idle" || phase === "error";
  if (outside && isExamRoot(root)) {
    guardedRoot = root;
    const reason = submittedRoots.has(root!)
      ? "This exam was submitted. Its files are read-only."
      : "This is an exam folder. To keep working on the exam, reopen it from Task Mentor (Open in TMCode).";
    useWorkbench.setState({ readOnly: true, readOnlyReason: reason });
    setPolicy({ ...PRACTICE_POLICY, terminal: "off" });
  } else if (guardedRoot && root !== guardedRoot && outside) {
    guardedRoot = null;
    useWorkbench.setState({ readOnly: false, readOnlyReason: null });
    setPolicy(PRACTICE_POLICY);
  } else if (!outside) {
    guardedRoot = null;
  }
}

onWorkspaceChanged(() => guardExamFolder());

const SESSIONS_KEY = (submissionId: number) => `exam.sessions.${submissionId}`;

/**
 * Journals of earlier sessions of this submission on this computer (a crash,
 * a relaunch, a second link). A new session has a new key and an empty
 * journal, so this is the only place unsent work from before survives.
 */
async function earlierJournals(submissionId: number, sessionId: string): Promise<JournalEntry[]> {
  const store = getPlatform().store;
  const sids = ((await store.get<string[]>(SESSIONS_KEY(submissionId)).catch(() => undefined)) ?? []).filter((s) => s !== sessionId);
  await store.set(SESSIONS_KEY(submissionId), [...sids, sessionId].slice(-10)).catch(() => {});
  const all: JournalEntry[] = [];
  for (const sid of sids) all.push(...(await host!.journal.load(sid).catch(() => [] as JournalEntry[])));
  return all;
}

const label = (t: { order: number; title: string }) => `Task ${t.order} (${t.title})`;

/**
 * Lays out one folder per task and picks, per task, which copy to start from:
 * this computer's (the task folder, or the latest snapshot of an earlier
 * session) or Task Mentor's. Copies are compared by content hash; sequence
 * numbers of different sessions say nothing about which is newer. Returns the
 * tasks whose local work Task Mentor never received (to snapshot again).
 */
async function prepareWorkspace(pkg: ExamPackage, sessionId: string, earlier: JournalEntry[]): Promise<number[]> {
  // Unsaved practice files are saved first: the launch ticket is used, so there is no Cancel.
  await saveDirtyFiles();
  const ws = await host!.openExamWorkspace(pkg.submission_id, pkg.quiz.title);
  if (!(await setWorkspace(ws))) throw new WorkspaceError("Save or close your unsaved files, then open the exam link again.");
  const fs = getPlatform().fs;
  const tasks: ExamTaskState[] = [];
  const replay: number[] = [];
  const notes: string[] = [];
  for (const t of [...pkg.tasks].sort((a, b) => a.order - b.order)) {
    const folder = `q${t.order}-${slug(t.title)}`;
    const current = journal.filter((j) => j.question_id === t.question_id);
    const before = earlier.filter((j) => j.question_id === t.question_id).sort((a, b) => a.client_ts.localeCompare(b.client_ts));
    const existing = await fs.readDir(folder).catch(() => null);
    const onDisk = existing ? await readFolder(folder) : [];
    const lastBefore = before.at(-1);
    // This computer's copy: the folder (never older than its journal), else the latest earlier snapshot.
    const local = onDisk.length ? { files: onDisk, hash: await filesHash(onDisk) } : lastBefore ? { files: lastBefore.files, hash: lastBefore.files_hash } : null;
    const server = t.resume ? { files: t.resume.files, hash: await filesHash(t.resume.files) } : null;
    const template = await filesHash(t.files);
    const sent = new Set([...before, ...current].filter((j) => j.synced).map((j) => j.files_hash));
    const known = new Set([...before, ...current].map((j) => j.files_hash));

    let files: { path: string; content: string }[] | null = null;
    if (!local) files = server?.files ?? t.files;
    else if (!server || local.hash === server.hash) {
      if (!onDisk.length) files = local.files;
      if (!server && local.hash !== template && !sent.has(local.hash)) replay.push(t.question_id);
    } else if (local.hash === template || sent.has(local.hash)) {
      // Task Mentor already had this computer's copy, so its different copy is newer (e.g. saved on another computer).
      files = server.files;
      if (local.hash !== template) {
        const dest = await setAside(folder, "this-computer", local.files);
        notes.push(`${label(t)}: your newer work from Task Mentor was loaded. The older files from this computer are in ${dest}.`);
      }
    } else {
      // This computer has work Task Mentor never received: keep it and send it now.
      if (!onDisk.length) files = local.files;
      replay.push(t.question_id);
      if (known.has(server.hash) || server.hash === template) {
        notes.push(`${label(t)}: TMCode restored work that had not reached Task Mentor before it closed. It is being sent now.`);
      } else {
        const dest = await setAside(folder, "task-mentor", server.files);
        notes.push(`${label(t)}: this computer and Task Mentor had different work. TMCode kept the work on this computer and is sending it. The Task Mentor copy is in ${dest}.`);
      }
    }
    if (!existing) await fs.createDir(folder).catch(() => {});
    if (files) await writeFolder(folder, files, !!onDisk.length);
    const profile = pkg.profiles.find((p) => p.id === t.profile_id);
    tasks.push({
      question_id: t.question_id,
      order: t.order,
      title: t.title,
      points: t.points,
      profile_id: t.profile_id,
      brief_md: t.brief_md,
      folder,
      entry: `${folder}/${t.files.find((f) => f.path === profile?.entry_point)?.path ?? t.files[0]?.path ?? profile?.entry_point ?? "main"}`,
      visible_tests: t.visible_tests,
      hidden_test_count: t.hidden_test_count,
      last_seq: current.at(-1)?.seq ?? (server || before.some((j) => j.synced) ? 1 : 0),
    });
  }
  set({ tasks, sessionId });
  await refreshExplorer();
  if (notes.length) notify("info", notes.join(" "));
  return replay;
}

/** Task Mentor accepts at most this many files per task snapshot (tmcode.controller.ts filesSchema .max(300)). */
export const MAX_TASK_FILES = 300;
const capWarned = new Set<string>();

async function readFolder(folder: string) {
  const fs = getPlatform().fs;
  const files: { path: string; content: string }[] = [];
  let skipped = 0;
  const walk = async (dir: string) => {
    for (const e of await fs.readDir(dir).catch(() => [])) {
      if (e.kind === "dir") await walk(e.path);
      else if (files.length < MAX_TASK_FILES) {
        const content = await fs.readFile(e.path).catch(() => null);
        if (content !== null) files.push({ path: e.path.slice(folder.length + 1), content });
      } else skipped++;
    }
  };
  await walk(folder);
  // Say so once per task: "All work saved" must never hide files that are not sent.
  if (skipped && !capWarned.has(folder) && get().phase !== "idle") {
    capWarned.add(folder);
    const t = get().tasks.find((x) => x.folder === folder);
    notify("warning", `${t ? label(t) : folder} has more than ${MAX_TASK_FILES} files. Only ${MAX_TASK_FILES} are sent to Task Mentor. Delete the files you don't need.`);
    log("Exam", `${folder}: ${skipped} file(s) over the ${MAX_TASK_FILES}-file cap were not snapshotted`, "warn");
  }
  return files;
}

/** Writes a copy into a task folder; `replace` first removes files the copy doesn't have. */
async function writeFolder(folder: string, files: { path: string; content: string }[], replace: boolean) {
  const fs = getPlatform().fs;
  if (replace) {
    const keep = new Set(files.map((f) => f.path));
    for (const f of await readFolder(folder)) if (!keep.has(f.path)) await fs.remove(`${folder}/${f.path}`).catch(() => {});
  }
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) await fs.createDir(`${folder}/${parts.slice(0, i).join("/")}`).catch(() => {});
    await fs.writeFile(`${folder}/${f.path}`, f.content);
  }
}

/** Keeps the copy that was not chosen under .recovered/ so nothing is ever silently lost. */
async function setAside(folder: string, from: string, files: { path: string; content: string }[]) {
  const fs = getPlatform().fs;
  const dest = `.recovered/${folder}-${from}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  for (const f of files) {
    const parts = `${dest}/${f.path}`.split("/");
    for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
    await fs.writeFile(`${dest}/${f.path}`, f.content);
  }
  return dest;
}

export function focusTask(questionId: number | null) {
  const t = get().tasks.find((x) => x.question_id === questionId);
  set({ activeTask: questionId });
  if (!t) return;
  setVisibleTests(
    t.entry,
    t.visible_tests.map((v, i) => ({ id: v.id, name: v.name ?? `Example ${i + 1}`, input: v.input, expected_output: v.expected_output })),
  );
  openFile(t.entry, { pinned: true });
}

// ───────────────────────── snapshots & sync ─────────────────────────

function readTaskFiles(t: ExamTaskState) {
  return readFolder(t.folder);
}

let snapshotChain: Promise<unknown> = Promise.resolve();
let inflight = 0;

/** Changes saved to disk but not yet in the journal (scheduled or being snapshotted). */
function updateQueued() {
  set({ sync: { ...get().sync, queued: dirtyTasks.size + inflight } });
}

/**
 * Appends a snapshot of one task to the journal (serialised: the chain must
 * stay in order). `at` stamps it with another time: the final snapshot after
 * time is up carries the deadline, when the editor locked.
 */
export function snapshot(questionId: number, kind: JournalEntry["kind"], at?: number): Promise<JournalEntry | null> {
  inflight++;
  updateQueued();
  const next = snapshotChain.then(async () => {
    const t = get().tasks.find((x) => x.question_id === questionId);
    const sid = get().sessionId;
    if (!t || !sid || !key || !host) return null;
    const files = await readTaskFiles(t);
    const files_hash = await filesHash(files);
    const prevForTask = [...journal].reverse().find((j) => j.question_id === questionId);
    // Nothing changed since the last auto snapshot of this task: skip (final/run always recorded).
    if (kind === "auto" && prevForTask?.files_hash === files_hash) return null;
    const seq = (journal[journal.length - 1]?.seq ?? 0) + 1;
    const rec = { seq, question_id: questionId, kind, client_ts: at !== undefined ? new Date(at).toISOString() : clock.iso(), files_hash };
    const hmac = await chainHmac(key, lastHmac, rec);
    const entry: JournalEntry = { ...rec, files, hmac, synced: false };
    await host.journal.append(sid, entry);
    journal.push(entry);
    lastHmac = hmac;
    set({ tasks: get().tasks.map((x) => (x.question_id === questionId ? { ...x, last_seq: seq } : x)), sync: { ...get().sync, pending: get().sync.pending + 1 } });
    void sync();
    return entry;
  });
  snapshotChain = next.catch(() => {});
  void next.finally(() => {
    inflight--;
    updateQueued();
  });
  return next;
}

/** Uploads unsent snapshots. Resolves when the upload in flight (if any) ends. */
export function sync(): Promise<void> {
  if (syncRun) return syncRun;
  if (!api || !host || syncStopped) return Promise.resolve();
  syncRun = runSync().finally(() => {
    syncRun = null;
  });
  return syncRun;
}

const unsent = () => journal.some((j) => !j.synced);

async function runSync() {
  const sid = get().sessionId!;
  try {
    for (const e of journal.filter((j) => !j.synced)) {
      await api!.snapshot({ seq: e.seq, question_id: e.question_id, kind: e.kind, client_ts: e.client_ts, files: e.files, files_hash: e.files_hash, hmac: e.hmac });
      e.synced = true;
      await host!.journal.markSynced(sid, e.seq);
      set({ sync: { ...get().sync, pending: journal.filter((j) => !j.synced).length, offline: false, lastSyncedAt: Date.now() } });
    }
    syncBackoff = 1000;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.offline || e.status >= 500) {
        set({ sync: { ...get().sync, offline: true } });
        // The submit loop retries on its own schedule.
        if (get().phase !== "submitting") setTimeout(() => void sync(), syncBackoff);
        syncBackoff = Math.min(syncBackoff * 2, 30_000);
      } else if (e.code === "JOURNAL_TAMPERED" || e.code === "SEQ_CONFLICT") {
        syncStopped = true;
        set({ sync: { ...get().sync, tampered: true } });
        notify("error", "Task Mentor could not accept your saved work. Tell your teacher straight away.");
      } else if (e.code === "SESSION_SUPERSEDED" || e.code === "SESSION_REVOKED" || e.code === "SESSION_SCOPE" || e.status === 401) {
        syncStopped = true;
        handleEnded(e.code);
      } else if (e.code === "ATTEMPT_TIME_EXPIRED") {
        if (get().phase === "submitting") {
          syncStopped = true;
          lockExam("time_rejected");
        } else timeUp();
      } else {
        log("Exam", `Sync failed: ${e.code} ${e.message}`, "error");
      }
    }
  }
}

// ───────────────────────── heartbeat, deadline ─────────────────────────

async function heartbeat() {
  if (!api || get().phase === "submitted") return;
  try {
    const hb = await api.heartbeat({
      synced_seq: journal.filter((j) => j.synced).reduce((m, j) => Math.max(m, j.seq), 0),
      current_question: get().activeTask,
      focus: document.hasFocus() ? "in" : "out",
    });
    clock.sync(hb.server_time);
    const deadline = Date.parse(hb.deadline);
    if (deadline !== get().deadline) {
      if (get().deadline && deadline > get().deadline!) notify("info", `Your teacher extended the time. New end: ${new Date(deadline).toLocaleTimeString()}.`);
      set({ deadline });
    }
    if (hb.message && hb.message !== get().message) notify("warning", `Message from your teacher: ${hb.message}`);
    set({ paused: hb.paused, message: hb.message, sync: { ...get().sync, offline: false } });
    if (hb.status !== "active") handleEnded(hb.status === "superseded" ? "SESSION_SUPERSEDED" : hb.status === "revoked" ? "SESSION_REVOKED" : "ENDED");
    if (get().sync.pending) void sync();
  } catch (e) {
    if (e instanceof ApiError && e.offline) set({ sync: { ...get().sync, offline: true } });
  }
}

function tick() {
  const { deadline, phase } = get();
  if (!deadline || phase !== "active") return;
  const left = deadline - clock.now();
  for (const mins of [10, 5, 1]) {
    if (left <= mins * 60_000 && left > (mins - 1) * 60_000 && !warned.has(mins)) {
      warned.add(mins);
      notify("warning", `${mins} minute${mins > 1 ? "s" : ""} left. Your work is saved automatically.`);
    }
  }
  if (left <= 0) timeUp();
}

/** The deadline passed: lock the editor and submit what was there at the deadline. */
function timeUp() {
  if (get().timeUp || get().phase !== "active") return;
  set({ timeUp: true });
  useWorkbench.setState({ readOnly: true });
  // Edits stop at the deadline; the final snapshots below record them.
  dirtyTasks.forEach(clearTimeout);
  dirtyTasks.clear();
  updateQueued();
  void submitExam({ auto: true });
}

function lockExam(reason: LockReason, detail?: string) {
  if (get().phase === "submitted") return;
  set({ phase: "locked", lock: { reason, detail }, retryAt: null });
  useWorkbench.setState({ readOnly: true });
}

function handleEnded(code: string) {
  void forgetInProgress(false);
  lockExam(code === "SESSION_SUPERSEDED" ? "superseded" : code === "SESSION_REVOKED" || code === "SESSION_SCOPE" ? "revoked" : "ended");
  stopTimers();
}

// ───────────────────────── submit ─────────────────────────

const retryable = (e: unknown) => e instanceof ApiError && (e.offline || e.status >= 500);

/** Waits `ms`, or less if the computer comes back online. */
function waitForRetry(ms: number) {
  set({ retryAt: Date.now() + ms });
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done);
  });
}

export async function submitExam(opts: { auto?: boolean } = {}) {
  const { tasks, phase } = get();
  if (!api || phase === "submitting" || phase === "submitted") return;
  if (phase === "locked" && get().lock?.reason !== "submit_failed") return;
  if (!opts.auto) {
    const choice = await showDialog({
      message: "Submit your exam?",
      detail: `${tasks.length} task${tasks.length > 1 ? "s" : ""} will be submitted and graded by Task Mentor. You can't change your code afterwards.`,
      buttons: [
        { id: "submit", label: "Submit", primary: true },
        { id: "cancel", label: "Keep working" },
      ],
      cancelId: "cancel",
    });
    if (choice !== "submit") return;
  }
  set({ phase: "submitting", lock: null, message: null });
  useWorkbench.setState({ readOnly: true });
  await saveAll();
  const deadline = get().deadline;
  // After time is up the final code is what the editor held at the deadline, so it carries the deadline's time.
  const late = deadline !== null && (get().timeUp || clock.now() > deadline);
  const offline = get().sync.offline || (typeof navigator !== "undefined" && navigator.onLine === false);
  const finals: { question_id: number; seq: number }[] = [];
  for (const t of tasks) {
    const e = await snapshot(t.question_id, late && offline ? "offline_final" : "final", late ? Math.min(clock.now(), deadline!) : undefined);
    if (e) finals.push({ question_id: t.question_id, seq: e.seq });
  }
  // Everything must be on the server before submitting; keep trying while offline.
  for (let attempt = 0; ; attempt++) {
    await sync();
    // A snapshot appended during an upload that was already running needs one more pass.
    if (unsent() && !get().sync.offline) await sync();
    // Task Mentor refused the journal or ended the session: the lock card explains why.
    if (get().phase !== "submitting") return;
    if (syncStopped && unsent()) {
      lockExam("submit_failed", "Task Mentor could not accept your saved work. Tell your teacher straight away.");
      return;
    }
    if (!unsent()) {
      try {
        await api.submit(finals);
        set({ phase: "submitted", message: null, retryAt: null });
        stopTimers();
        void forgetInProgress(true);
        log("Exam", "Submitted");
        void pollResults();
        return;
      } catch (e) {
        if (!retryable(e)) {
          const msg = e instanceof ApiError ? e.message : String(e);
          log("Exam", `Submitting failed: ${msg}`, "error");
          lockExam("submit_failed", msg);
          return;
        }
        set({ sync: { ...get().sync, offline: true } });
      }
    }
    await waitForRetry(Math.min(2000 * (attempt + 1), 15_000));
    if (get().phase !== "submitting") return;
    set({ retryAt: null });
  }
}

async function pollResults() {
  for (let i = 0; i < 40 && api; i++) {
    try {
      const r = await api.results();
      set({ results: r });
      if (r.status !== "grading") return;
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  // Still grading after two minutes: stop the spinner and say where the results will appear.
  if (api && get().phase === "submitted") set({ resultsSlow: true });
}

// ───────────────────────── server run (E2) ─────────────────────────

/** Task Mentor allows 10 server runs a minute (PROTOCOL.md §3); kept here to say when the next one can start. */
const SERVER_RUNS_PER_MIN = 10;
const serverRunTimes: number[] = [];

function secondsUntilNextRun(now = Date.now()) {
  const recent = serverRunTimes.filter((t) => now - t < 60_000);
  if (recent.length < SERVER_RUNS_PER_MIN) return 0;
  return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
}

/**
 * The example tests on Task Mentor, when this computer can't run them (the
 * language's tool is missing). Results go to the Testing view like local ones.
 */
async function runVisibleTestsOnServer(ids?: string[]): Promise<boolean> {
  const { tests } = useWorkbench.getState();
  const t = tests.entry ? taskOfPath(tests.entry) : undefined;
  if (!api || !t || get().phase !== "active" || tests.source !== "exam") return false;
  const retryAt = useServerRun.getState().retryAt;
  if (retryAt && retryAt > Date.now()) {
    notify("info", `Task Mentor allows 10 test runs a minute. Run again in ${Math.ceil((retryAt - Date.now()) / 1000)} s.`);
    return true;
  }
  const local = secondsUntilNextRun();
  if (local) {
    useServerRun.setState({ status: "idle", retryAt: Date.now() + local * 1000 });
    notify("info", `Task Mentor allows 10 test runs a minute. Run again in ${local} s.`);
    return true;
  }
  const selected = tests.items.filter((x) => !ids || ids.includes(x.id));
  for (const x of selected) updateTest(x.id, { status: "queued", message: "Running on Task Mentor… (queued)", actual: undefined, stderr: undefined, duration_ms: undefined });
  setTests({ running: true });
  useServerRun.setState({ status: "queued", retryAt: null, error: null });
  try {
    // A run is recorded like a local one: the journal holds exactly what was tested.
    void snapshot(t.question_id, "run");
    const files = await readTaskFiles(t);
    serverRunTimes.push(Date.now());
    if (serverRunTimes.length > 50) serverRunTimes.splice(0, serverRunTimes.length - 50);
    const res = await api.serverRun(t.question_id, files);
    const byId = new Map(res.tests.map((r) => [r.id, r]));
    let passed = 0;
    for (const x of selected) {
      const r = byId.get(x.id);
      if (!r) {
        updateTest(x.id, { status: "error", message: "Task Mentor did not run this test." });
        continue;
      }
      const ok = r.passed === true || (r.passed === null && (r.verdict === "accepted" || r.verdict === "ok"));
      if (ok) passed++;
      const error = ["runtime-error", "compile-error", "internal-error"].includes(r.verdict);
      updateTest(x.id, {
        status: ok ? "passed" : error ? "error" : "failed",
        actual: r.stdout,
        stderr: r.stderr,
        duration_ms: typeof r.time_ms === "number" ? r.time_ms : undefined,
        message: ok ? "Passed on Task Mentor" : `${verdictLabel(r.verdict) ?? "Failed"} (on Task Mentor)`,
      });
    }
    log("Tests", `${passed}/${selected.length} visible tests passed (run on Task Mentor)`);
    useServerRun.setState({ status: "idle", lastRunAt: Date.now() });
  } catch (e) {
    const err = e instanceof ApiError ? e : null;
    let message: string;
    if (err?.code === "RATE_LIMITED") {
      const secs = Number(err.data.retry_after_s) > 0 ? Math.ceil(Number(err.data.retry_after_s)) : secondsUntilNextRun() || 30;
      useServerRun.setState({ retryAt: Date.now() + secs * 1000 });
      message = `Too many runs. Run again in ${secs} s.`;
    } else if (err?.offline) message = "Task Mentor can't be reached. Check your connection.";
    else if (err?.code === "JUDGE_UNAVAILABLE") message = "Task Mentor's code runner is busy. Try again in a moment.";
    else message = err?.message ?? String((e as Error)?.message ?? e);
    for (const x of selected) updateTest(x.id, { status: "idle", message });
    useServerRun.setState({ status: "idle", error: message });
    log("Tests", `Server run failed: ${err?.code ?? ""} ${message}`, "warn");
  } finally {
    setTests({ running: false });
  }
  return true;
}

setServerRunner(runVisibleTestsOnServer);

// ───────────────────────── wiring ─────────────────────────

function wire() {
  stopTimers();
  warned = new Set();
  timers.push(setInterval(tick, 1000));
  timers.push(setInterval(() => void heartbeat(), HEARTBEAT_MS));
  void heartbeat();
  // Snapshot a task a few seconds after its files are saved.
  unsubscribeDocs = onDocumentChanged((path) => {
    if (useWorkbench.getState().dirty[path]) return; // saves only
    const t = taskOfPath(path);
    if (!t || get().phase !== "active") return;
    if (dirtyTasks.has(t.question_id)) return;
    dirtyTasks.set(
      t.question_id,
      setTimeout(() => {
        dirtyTasks.delete(t.question_id);
        void snapshot(t.question_id, "auto");
      }, SNAPSHOT_EVERY_MS),
    );
    updateQueued();
  });
  unsubscribeRuns = onRunStarted(snapshotForRun);
  window.addEventListener("online", onOnline);
}

const onOnline = () => {
  void sync();
  void heartbeat();
};

function stopTimers() {
  timers.splice(0).forEach(clearInterval);
  dirtyTasks.forEach(clearTimeout);
  dirtyTasks.clear();
  unsubscribeDocs?.();
  unsubscribeDocs = null;
  unsubscribeRuns?.();
  unsubscribeRuns = null;
  window.removeEventListener("online", onOnline);
}

/** Leaves exam mode (after submit, or to open another exam). */
export function stopExam() {
  stopTimers();
  lobbyLeave?.();
  capWarned.clear();
  set({ ...initialExamState });
  setPolicy(PRACTICE_POLICY);
  useWorkbench.setState({ readOnly: false, readOnlyReason: null });
  setTests({ entry: null, items: [], source: null });
  void loadTests();
  // Still in the exam folder (Close exam): read-only from now on, never practice mode.
  guardExamFolder();
}

/** Called when a run starts: record exactly what was run. */
export function snapshotForRun(path: string) {
  const t = taskOfPath(path);
  if (t && get().phase === "active") void snapshot(t.question_id, "run");
}

export function remainingLabel() {
  const d = get().deadline;
  return d ? formatRemaining(d - clock.now()) : "";
}
