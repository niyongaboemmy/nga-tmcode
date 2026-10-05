import { chainHmac, filesHash, journalKey, type ExamPackage } from "@tmcode/protocol";
import { onDocumentChanged, saveAll } from "../monaco/documents";
import { onRunStarted } from "../run/runService";
import { loadTests, setVisibleTests } from "../run/testService";
import type { ExamHost, JournalEntry } from "../platform/types";
import { getPlatform, log, notify, openFile, refreshExplorer, revealView, setPolicy, setTests, setWorkspace, showDialog, useWorkbench } from "../state/store";
import { PRACTICE_POLICY } from "@tmcode/protocol";
import { ApiError, TmApi, isAllowedApi } from "./api";
import { ServerClock, formatRemaining } from "./clock";
import { initialExamState, useExam, type ExamTaskState } from "./state";

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
let syncing = false;
let syncBackoff = 1000;
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
  if (!isAllowedApi(apiBase, host.dev)) {
    set({ phase: "error", error: `This link points to an unknown server (${apiBase}). Open the exam from Task Mentor again.` });
    return;
  }
  set({ ...initialExamState, phase: "starting" });
  api = new TmApi(apiBase, (u, i) => host!.fetch(u, i));
  try {
    const device = await host.device();
    const toolchains = await host.toolchains().catch(() => []);
    const grant = await api.redeem(ticket, device, { toolchains });
    const pkg = await api.examPackage();
    clock.sync(pkg.server_time);
    key = await journalKey(pkg.journal_nonce, grant.session_id);
    journal = await host.journal.load(grant.session_id);
    lastHmac = journal.length ? journal[journal.length - 1].hmac : "";
    await prepareWorkspace(pkg, grant.session_id);
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
    void sync();
  } catch (e) {
    const msg =
      e instanceof ApiError
        ? e.code === "TICKET_USED" || e.code === "TICKET_INVALID"
          ? "This exam link has expired or was already used. Go back to Task Mentor and choose Open in TMCode again."
          : e.offline
            ? "TMCode can't reach Task Mentor. Check your connection and open the exam link again."
            : e.message
        : String((e as Error)?.message ?? e);
    set({ phase: "error", error: msg });
  }
}

async function prepareWorkspace(pkg: ExamPackage, sessionId: string) {
  const ws = await host!.openExamWorkspace(pkg.submission_id, pkg.quiz.title);
  await setWorkspace(ws);
  const fs = getPlatform().fs;
  const tasks: ExamTaskState[] = [];
  for (const t of [...pkg.tasks].sort((a, b) => a.order - b.order)) {
    const folder = `q${t.order}-${slug(t.title)}`;
    const local = journal.filter((j) => j.question_id === t.question_id);
    const localSeq = local.length ? local[local.length - 1].seq : 0;
    const existing = await fs.readDir(folder).catch(() => null);
    // Use the newest copy: this computer's folder, or the server's (e.g. after switching computers).
    const serverNewer = t.resume && t.resume.snapshot_seq > localSeq;
    const files = serverNewer ? t.resume!.files : !existing ? (t.resume?.files ?? t.files) : null;
    if (!existing) await fs.createDir(folder).catch(() => {});
    if (files && existing) await keepLocalCopy(folder, files);
    if (files) {
      for (const f of files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) await fs.createDir(`${folder}/${parts.slice(0, i).join("/")}`).catch(() => {});
        await fs.writeFile(`${folder}/${f.path}`, f.content);
      }
    }
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
      last_seq: Math.max(localSeq, t.resume?.snapshot_seq ?? 0),
    });
  }
  set({ tasks, sessionId });
  await refreshExplorer();
}

/**
 * Before the server's copy replaces a task folder that has different local
 * files (e.g. offline work from an earlier session on this computer), keep the
 * local files under .recovered/ so nothing is ever silently lost.
 */
async function keepLocalCopy(folder: string, incoming: { path: string; content: string }[]) {
  const fs = getPlatform().fs;
  const changed: { path: string; content: string }[] = [];
  for (const f of incoming) {
    const local = await fs.readFile(`${folder}/${f.path}`).catch(() => null);
    if (local !== null && local !== f.content) changed.push({ path: f.path, content: local });
  }
  if (!changed.length) return;
  const dest = `.recovered/${folder}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  for (const f of changed) {
    const parts = `${dest}/${f.path}`.split("/");
    for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
    await fs.writeFile(`${dest}/${f.path}`, f.content);
  }
  notify("info", `Your newer work from Task Mentor was loaded. The previous files on this computer are kept in ${dest}.`);
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

async function readTaskFiles(t: ExamTaskState) {
  const fs = getPlatform().fs;
  const files: { path: string; content: string }[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readDir(dir).catch(() => [])) {
      if (e.kind === "dir") await walk(e.path);
      else if (files.length < 100) {
        const content = await fs.readFile(e.path).catch(() => null);
        if (content !== null) files.push({ path: e.path.slice(t.folder.length + 1), content });
      }
    }
  };
  await walk(t.folder);
  return files;
}

let snapshotChain: Promise<unknown> = Promise.resolve();
let inflight = 0;

/** Changes saved to disk but not yet in the journal (scheduled or being snapshotted). */
function updateQueued() {
  set({ sync: { ...get().sync, queued: dirtyTasks.size + inflight } });
}

/** Appends a snapshot of one task to the journal (serialised: the chain must stay in order). */
export function snapshot(questionId: number, kind: JournalEntry["kind"]): Promise<JournalEntry | null> {
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
    const rec = { seq, question_id: questionId, kind, client_ts: clock.iso(), files_hash };
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

export async function sync() {
  if (syncing || !api || !host) return;
  syncing = true;
  const sid = get().sessionId!;
  try {
    for (const e of journal.filter((j) => !j.synced)) {
      await api.snapshot({ seq: e.seq, question_id: e.question_id, kind: e.kind, client_ts: e.client_ts, files: e.files, files_hash: e.files_hash, hmac: e.hmac });
      e.synced = true;
      await host.journal.markSynced(sid, e.seq);
      set({ sync: { ...get().sync, pending: journal.filter((j) => !j.synced).length, offline: false, lastSyncedAt: Date.now() } });
    }
    syncBackoff = 1000;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.offline || e.status >= 500) {
        set({ sync: { ...get().sync, offline: true } });
        setTimeout(() => void sync(), syncBackoff);
        syncBackoff = Math.min(syncBackoff * 2, 30_000);
      } else if (e.code === "JOURNAL_TAMPERED" || e.code === "SEQ_CONFLICT") {
        set({ sync: { ...get().sync, tampered: true } });
        notify("error", "Task Mentor could not accept your saved work. Tell your teacher straight away.");
      } else if (e.code === "SESSION_SUPERSEDED" || e.code === "SESSION_REVOKED" || e.code === "SESSION_SCOPE" || e.status === 401) {
        handleEnded(e.code);
      } else if (e.code === "ATTEMPT_TIME_EXPIRED") {
        lockExam("Time is up.");
      } else {
        log("Exam", `Sync failed: ${e.code} ${e.message}`, "error");
      }
    }
  } finally {
    syncing = false;
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
  if (left <= 0) {
    lockExam("Time is up. Your work is being submitted.");
    void submitExam({ auto: true });
  }
}

function lockExam(message: string) {
  if (get().phase === "submitted") return;
  set({ phase: "locked", message });
  useWorkbench.setState({ readOnly: true });
}

function handleEnded(code: string) {
  const message =
    code === "SESSION_SUPERSEDED"
      ? "This exam was opened on another computer or window. Continue there; your work up to now is saved."
      : code === "SESSION_REVOKED"
        ? "Your exam session was ended. Your saved work stays with Task Mentor."
        : "This exam has ended.";
  lockExam(message);
  stopTimers();
}

// ───────────────────────── submit ─────────────────────────

export async function submitExam(opts: { auto?: boolean } = {}) {
  const { tasks, phase } = get();
  if (!api || phase === "submitting" || phase === "submitted") return;
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
  set({ phase: "submitting" });
  useWorkbench.setState({ readOnly: true });
  await saveAll();
  const late = get().deadline !== null && clock.now() > get().deadline!;
  const finals: { question_id: number; seq: number }[] = [];
  for (const t of tasks) {
    const e = await snapshot(t.question_id, late && get().sync.offline ? "offline_final" : "final");
    if (e) finals.push({ question_id: t.question_id, seq: e.seq });
  }
  // Everything must be on the server before submitting; keep trying while offline.
  for (let attempt = 0; journal.some((j) => !j.synced); attempt++) {
    await sync();
    if (journal.some((j) => !j.synced)) {
      set({ message: "Saved on this computer — waiting for a connection to submit. Do not close TMCode." });
      await new Promise((r) => setTimeout(r, Math.min(2000 * (attempt + 1), 15_000)));
    }
  }
  try {
    await api.submit(finals);
    set({ phase: "submitted", message: null });
    stopTimers();
    log("Exam", "Submitted");
    void pollResults();
  } catch (e) {
    set({ phase: "locked", message: e instanceof ApiError ? e.message : String(e) });
    notify("error", `Submitting failed: ${e instanceof ApiError ? e.message : String(e)}`, [{ label: "Try again", run: () => void submitExam({ auto: true }) }]);
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
}

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
  set({ ...initialExamState });
  setPolicy(PRACTICE_POLICY);
  useWorkbench.setState({ readOnly: false });
  setTests({ entry: null, items: [], source: null });
  void loadTests();
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
