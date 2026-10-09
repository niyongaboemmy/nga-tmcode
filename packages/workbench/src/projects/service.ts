import { beginActivity, track } from "../state/activity";
import { create } from "zustand";
import { inExam } from "../exam/state";
import type { AccountStatus, TmRequest } from "../platform/types";
import { useGit } from "../scm/gitService";
import { activeFilePath, confirmLeaveWorkspace, getPlatform, log, notify, notifyProgress, openPathFromOs, openRecent, showDialog, useWorkbench } from "../state/store";
import { applyExternalChanges } from "../monaco/external";
import { changeCount, planSync, type Manifest, type SyncPlan } from "./plan";
import type { Binding, Link, Project, ProjectKind, Revision, SyncState } from "./types";

/**
 * Task Mentor projects in TMCode (docs/PROJECTS_PLAN.md §4): the NGA account,
 * the project lists, and the open folder's binding + sync with Task Mentor.
 */

const BINDING = ".tmcode/project.json";
const FOLDERS_KEY = "projects.folders";
const DEVICE_KEY = "projects.deviceId";

export interface ProjectsState {
  account: AccountStatus | null;
  mine: Project[] | null;
  shared: Project[] | null;
  /** Removed projects, loaded when the Removed section opens. */
  removed: Project[] | null;
  loading: boolean;
  error: string | null;
  /** The open folder's project, if it is one. */
  binding: Binding | null;
  current: Project | null;
  plan: SyncPlan | null;
  sync: SyncState;
  syncMessage: string | null;
  lastSyncAt: number | null;
}

export const useProjects = create<ProjectsState>(() => ({
  account: null,
  mine: null,
  shared: null,
  removed: null,
  loading: false,
  error: null,
  binding: null,
  current: null,
  plan: null,
  sync: "unbound",
  syncMessage: null,
  lastSyncAt: null,
}));

const set = useProjects.setState;
const get = useProjects.getState;

export function projectsSupported() {
  try {
    return !!getPlatform().account && !inExam();
  } catch {
    return false;
  }
}

export const signedIn = () => !!get().account?.signed_in;

// ── API ──────────────────────────────────────────────────────────────────

export class TmError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(method: TmRequest["method"], path: string, json?: unknown, extra: Partial<TmRequest> = {}): Promise<T> {
  const host = getPlatform().account;
  if (!host) throw new TmError(0, "UNSUPPORTED", "Task Mentor projects are available in the TMCode desktop app.");
  // Every request shows as activity at once (progress line, status bar), whoever made it.
  const end = beginActivity("Task Mentor…");
  let res;
  try {
    res = await host.request<Record<string, unknown>>({ method, path: `/api/tmcode${path}`, json, ...extra });
  } finally {
    end();
  }
  if (res.status >= 200 && res.status < 300) return res.body as T;
  const body = (res.body ?? {}) as Record<string, unknown>;
  // Task Mentor answers `error_code`; some newer answers (QUIZ_NOT_OPEN, MIS_SCOPE_UNAVAILABLE) say `code`.
  throw new TmError(res.status, String(body.error_code ?? body.code ?? `HTTP_${res.status}`), String(body.message ?? `Task Mentor answered ${res.status}.`), body);
}

// ── Account ──────────────────────────────────────────────────────────────

let wired = false;
export function wireProjects() {
  const host = (() => {
    try {
      return getPlatform().account;
    } catch {
      return undefined;
    }
  })();
  if (!host || wired) return;
  wired = true;
  host.onChange((account) => {
    const was = signedIn();
    set({ account });
    if (account.signed_in && !was) {
      notify("info", `Signed in to NGA as ${account.user?.name ?? account.user?.email ?? "you"}.`);
      void refreshProjects();
      void bindWorkspace();
    }
    if (!account.signed_in && was) set({ mine: null, shared: null });
  });
  void host.status(true).then((account) => {
    set({ account });
    if (account.signed_in) void refreshProjects();
  });
  // Re-check the session every 10 minutes: an MIS sign-out elsewhere ends it here too.
  setInterval(() => void host.status(true).then((account) => set({ account })), 10 * 60_000);
  // Follow the open folder.
  let root = useWorkbench.getState().workspace?.root;
  useWorkbench.subscribe((s) => {
    if (s.workspace?.root === root) return;
    void sendPresence(false);
    root = s.workspace?.root;
    void bindWorkspace();
  });
  startHeartbeats();
  void bindWorkspace();
  void import("./assignments").then((m) => m.wireAssignments());
  void import("../grading/service").then((m) => m.wireGrading());
}

export async function signIn() {
  const host = getPlatform().account;
  if (!host) return;
  if (inExam()) return notify("info", "Signing in is not available during an exam.");
  try {
    await host.signIn();
    notify("info", "Continue in your browser to sign in with your NGA account.");
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  }
}

export async function signOut() {
  const host = getPlatform().account;
  if (!host) return;
  const choice = await showDialog({
    severity: "info",
    message: "Sign out of NGA?",
    detail: "This signs you out of Central MIS and Task Mentor everywhere. Your files stay on this computer.",
    buttons: [
      { id: "out", label: "Sign Out", primary: true, destructive: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "out") return;
  await host.signOut();
  set({ account: await host.status(false), mine: null, shared: null });
}

/** Projects need both sessions: asks to sign in otherwise. */
async function requireSignIn(): Promise<boolean> {
  if (signedIn()) return true;
  const choice = await showDialog({
    severity: "info",
    message: "Sign in with your NGA account",
    detail: "Task Mentor projects need you to be signed in to Central MIS and Task Mentor. One sign-in does both.",
    buttons: [
      { id: "in", label: "Sign In", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice === "in") await signIn();
  return false;
}

// ── Lists ────────────────────────────────────────────────────────────────

export async function refreshProjects() {
  if (!signedIn()) return;
  set({ loading: true, error: null });
  try {
    const [mine, shared] = await Promise.all([
      api<{ projects: Project[] }>("GET", "/projects?scope=mine"),
      api<{ projects: Project[] }>("GET", "/projects?scope=shared"),
    ]);
    set({ mine: mine.projects, shared: shared.projects, loading: false });
  } catch (e) {
    set({ loading: false, error: (e as Error).message });
  }
}

export async function createProject(input: { name: string; description?: string; language?: string; kind: ProjectKind; repo_url?: string }): Promise<Project | null> {
  if (!(await requireSignIn())) return null;
  const res = await api<{ project: Project }>("POST", "/projects", input);
  void refreshProjects();
  return res.project;
}

// ── Binding (.tmcode/project.json) ────────────────────────────────────────

async function readBinding(): Promise<Binding | null> {
  if (!useWorkbench.getState().workspace) return null;
  try {
    const b = JSON.parse(await getPlatform().fs.readFile(BINDING)) as Binding;
    return typeof b.project_id === "number" ? b : null;
  } catch {
    return null;
  }
}

async function writeBinding(b: Binding) {
  const fs = getPlatform().fs;
  await fs.createDir(".tmcode").catch(() => {});
  await fs.writeFile(BINDING, `${JSON.stringify(b, null, 2)}\n`);
  set({ binding: b });
}

async function rememberFolder(projectId: number) {
  const root = useWorkbench.getState().workspace?.root;
  if (!root) return;
  const store = getPlatform().store;
  const map = (await store.get<Record<string, string>>(FOLDERS_KEY)) ?? {};
  map[String(projectId)] = root;
  await store.set(FOLDERS_KEY, map);
}

/** The open folder changed: is it a Task Mentor project? */
/** A completed assignment's workspace is read-only (Task Mentor refuses its saves too). */
let readOnlyByProject = false;
/** Why the open project can't be changed, if it can't (completed assignment, or a submitted/graded/removed project). */
export function lockReason(project: Project | null | undefined): string | null {
  if (!project) return null;
  const name = `"${project.assignment?.title ?? project.name}"`;
  if (project.read_only) return `${name} is completed: this workspace is read-only.`;
  if (project.my_role && project.my_role !== "owner" && (project.status === "submitted" || project.status === "graded")) {
    return `Reviewing ${project.owner?.name ?? "a student"}'s submission: ${project.name} (read-only).`;
  }
  if (project.status === "submitted") return `${name} is submitted: use Withdraw to Edit (Projects view) to keep editing.`;
  if (project.status === "graded") return `${name} is graded: this workspace is read-only.`;
  if (project.status === "removed") return `${name} was removed: restore it (Task Mentor Projects › Removed) to edit it again.`;
  return null;
}

function applyReadOnly(project: Project | null) {
  if (inExam()) return;
  const reason = lockReason(project);
  if (reason) {
    readOnlyByProject = true;
    useWorkbench.setState({ readOnly: true, readOnlyReason: reason });
  } else if (readOnlyByProject) {
    readOnlyByProject = false;
    useWorkbench.setState({ readOnly: false, readOnlyReason: null });
  }
}

export async function bindWorkspace() {
  const binding = await readBinding();
  if (!binding) applyReadOnly(null);
  set({ binding, current: null, plan: null, sync: binding ? "checking" : "unbound", syncMessage: null });
  if (!binding || !signedIn()) {
    if (binding) set({ sync: "offline", syncMessage: "Sign in to sync this project." });
    return;
  }
  await rememberFolder(binding.project_id);
  await checkSync();
}

/** Makes the open folder a new project's working copy (first save uploads it). */
export async function connectFolder(project: Project) {
  await writeBinding({ project_id: project.id, tm_api: get().account?.tm_api ?? "", kind: project.kind, name: project.name, base_revision_id: null, base: null });
  await rememberFolder(project.id);
  await checkSync();
}

// ── Sync ─────────────────────────────────────────────────────────────────

async function headManifest(projectId: number): Promise<{ head: Revision | null; files: Manifest | null }> {
  try {
    const res = await api<{ revision: Revision; files: Manifest }>("GET", `/projects/${projectId}/revisions/head/manifest`);
    return { head: res.revision, files: res.files };
  } catch (e) {
    if (e instanceof TmError && (e.code === "NO_REVISIONS" || e.status === 404)) return { head: null, files: null };
    throw e;
  }
}

function stateOf(plan: SyncPlan): SyncState {
  if (plan.conflicts.length) return "conflict";
  const l = changeCount(plan.localChanges);
  const r = changeCount(plan.remoteChanges);
  return l && r ? "both" : l ? "local-changes" : r ? "remote-changes" : "synced";
}

let checking: Promise<void> | null = null;
/** Compares the folder, its last sync and Task Mentor's head. */
/** A check that starts after any check in flight (one that began before a change would report the old state). */
export async function recheck(): Promise<void> {
  if (checking) await checking.catch(() => {});
  await checkSync();
}

export function checkSync(): Promise<void> {
  checking ??= (async () => {
    const binding = get().binding;
    const host = getPlatform().account;
    if (!binding || !host || !signedIn()) return;
    try {
      const { project } = await api<{ project: Project }>("GET", `/projects/${binding.project_id}`);
      set({ current: project });
      applyReadOnly(project);
      if (project.kind === "github") {
        set({ sync: "synced", plan: null, syncMessage: null });
        void reportGit();
        return;
      }
      const [scan, remote] = await Promise.all([host.scan(), headManifest(binding.project_id)]);
      const plan = planSync(binding.base, scan.files, remote.files);
      set({ plan, sync: stateOf(plan), syncMessage: scan.truncated });
    } catch (e) {
      const offline = !(e instanceof TmError) || e.status === 0;
      set({ sync: offline ? "offline" : "error", syncMessage: (e as Error).message });
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Save to Task Mentor: uploads only new content, then commits a revision. */
async function saveToTaskMentorNow(opts: { message?: string; source?: "save" | "auto" | "submit"; quiet?: boolean } = {}): Promise<Revision | null> {
  const binding = get().binding;
  const host = getPlatform().account;
  if (!binding || !host) {
    if (!opts.quiet) notify("info", "This folder is not a Task Mentor project. Use Projects › Connect This Folder first.");
    return null;
  }
  if (!(await requireSignIn())) return null;
  if (binding.kind === "github") {
    if (!opts.quiet) notify("info", "This is a GitHub project: commit and push in Source Control. Task Mentor follows your pushes.");
    return null;
  }
  const locked = lockReason(get().current);
  if (locked) {
    lastSaveError = new TmError(409, "PROJECT_LOCKED", locked);
    if (!opts.quiet) notify("info", locked);
    return null;
  }
  await checkSync();
  const plan = get().plan;
  if (!plan) return null;
  if (plan.conflicts.length) {
    if (!opts.quiet) notify("warning", `${plan.conflicts.length} file(s) changed both here and in Task Mentor. Resolve them first under Conflicts in the Task Mentor Projects view.`);
    return null;
  }
  if (changeCount(plan.remoteChanges)) {
    await pullFromTaskMentor({ quiet: true });
    if (get().sync === "conflict") return null;
  }
  const current = get().plan ?? plan;
  if (!changeCount(current.localChanges) && get().binding?.base) {
    if (!opts.quiet) notify("info", "Everything is already saved to Task Mentor.");
    return null;
  }
  set({ sync: "saving" });
  const progress = opts.quiet ? null : notifyProgress(`Saving ${binding.name} to Task Mentor…`);
  try {
    const files = current.next;
    const shas = [...new Set(files.map((f) => f.sha256))];
    const { missing } = await api<{ missing: string[] }>("POST", `/projects/${binding.project_id}/blobs/missing`, { sha256: shas });
    let done = 0;
    for (const sha of missing) {
      const file = files.find((f) => f.sha256 === sha)!;
      const [actual, gz] = await host.readBlob(file.path);
      if (actual !== sha) throw new Error(`${file.path} changed while saving. Try again.`);
      await api("PUT", `/projects/${binding.project_id}/blobs/${sha}`, undefined, { body_base64: gz, content_type: "application/gzip" });
      progress?.update({ message: `Uploading ${file.path}…`, progress: Math.round((++done / missing.length) * 100) });
    }
    const message = opts.message ?? defaultMessage(current);
    const body = { base_revision_id: get().binding?.base_revision_id ?? null, message, files, source: opts.source ?? "save" };
    let res: { revision: Revision; unchanged?: boolean };
    try {
      res = await api("POST", `/projects/${binding.project_id}/revisions`, body);
    } catch (e) {
      if (e instanceof TmError && e.code === "REVISION_CONFLICT") {
        // Someone saved in between (another computer): bring it down, then the user saves again.
        await pullFromTaskMentor({ quiet: true });
        throw new Error("Task Mentor had newer changes. They were brought into this folder; check them and save again.");
      }
      throw e;
    }
    await writeBinding({ ...get().binding!, base_revision_id: res.revision.id, base: files });
    set({ lastSyncAt: Date.now() });
    log("Projects", `Saved revision ${res.revision.number} of ${binding.name} (${missing.length} new file(s) uploaded)`);
    if (!opts.quiet) notify("info", res.unchanged ? "Everything is already saved to Task Mentor." : `Saved to Task Mentor (revision ${res.revision.number}).`);
    await checkSync();
    return res.revision;
  } catch (e) {
    lastSaveError = e;
    set({ sync: "error", syncMessage: saveFailureMessage(e, "save") });
    if (!opts.quiet) notify("error", saveFailureMessage(e, "save"));
    return null;
  } finally {
    progress?.close();
  }
}

/** The last save's failure: submitting says why it couldn't save first. */
let lastSaveError: unknown = null;

const isOffline = (e?: unknown) => (typeof navigator !== "undefined" && navigator.onLine === false) || (e instanceof TmError && e.status === 0);

const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${Math.round((n / 1_048_576) * 10) / 10} MB`);

/**
 * Why saving (before a submit) failed, in words that say what to do:
 * offline, too large for Task Mentor's limits, locked, or conflicts.
 */
export function saveFailureMessage(e: unknown, doing: "save" | "submit"): string {
  if (isOffline(e) || (!e && get().sync === "offline")) return `You're offline. Your work is safe on this computer; ${doing} when you're back online.`;
  if (e instanceof TmError && (e.status === 413 || e.code === "QUOTA_EXCEEDED" || e.code === "FILE_TOO_LARGE")) {
    const max = Number(e.body.max);
    const limit =
      e.body.limit === "files" && max
        ? `Task Mentor keeps at most ${max} files per project`
        : e.body.limit === "file_size" && max
          ? `each file can be at most ${size(max)}${e.body.path ? ` (${String(e.body.path)} is bigger)` : ""}`
          : e.body.limit === "project_size" && max
            ? `a project can be at most ${size(max)} in all`
            : e.message;
    return `This project is too large to ${doing}: ${limit.replace(/\.$/, "")}. Remove big files you don't need (build output, videos, node_modules), then ${doing} again.`;
  }
  if (e instanceof TmError && ["PROJECT_LOCKED", "PROJECT_GRADED", "PROJECT_REMOVED", "ASSIGNMENT_READ_ONLY"].includes(e.code)) return lockReason(get().current) ?? e.message;
  const conflicts = get().plan?.conflicts.length ?? 0;
  if (conflicts) return `${conflicts} file${conflicts === 1 ? "" : "s"} changed both here and in Task Mentor. Resolve ${conflicts === 1 ? "it" : "them"} under Conflicts in the Task Mentor Projects view, then ${doing} again.`;
  if (e instanceof Error && e.message) return e.message;
  if (get().sync === "error" && get().syncMessage) return get().syncMessage!;
  return doing === "submit" ? "Your work couldn't be saved to Task Mentor, so nothing was submitted. Try again." : "Your work couldn't be saved to Task Mentor. Try again.";
}

function defaultMessage(plan: SyncPlan) {
  const c = plan.localChanges;
  const parts = [c.added.length && `${c.added.length} added`, c.modified.length && `${c.modified.length} changed`, c.deleted.length && `${c.deleted.length} deleted`].filter(Boolean);
  return parts.length ? `Saved from TMCode: ${parts.join(", ")}` : "Saved from TMCode";
}

/** Brings Task Mentor's newer files into this folder (conflicts are kept for the user). */
async function pullFromTaskMentorNow(opts: { quiet?: boolean } = {}) {
  const binding = get().binding;
  const host = getPlatform().account;
  if (!binding || !host || binding.kind !== "tm") return;
  set({ sync: "pulling" });
  const progress = opts.quiet ? null : notifyProgress(`Getting ${binding.name} from Task Mentor…`);
  try {
    const remote = await headManifest(binding.project_id);
    if (!remote.files || !remote.head) {
      await checkSync();
      return;
    }
    const scan = await host.scan();
    const plan = planSync(binding.base, scan.files, remote.files);
    const R = new Map(remote.files.map((f) => [f.path, f]));
    const toWrite = [...plan.remoteChanges.added, ...plan.remoteChanges.modified];
    let done = 0;
    for (const path of toWrite) {
      const f = R.get(path)!;
      const res = await api<{ base64: string }>("GET", `/projects/${binding.project_id}/blobs/${f.sha256}`, undefined, { response: "base64" });
      await host.writeBlob(path, f.sha256, res.base64);
      progress?.update({ message: `Downloading ${path}…`, progress: Math.round((++done / Math.max(1, toWrite.length)) * 100) });
    }
    for (const path of plan.remoteChanges.deleted) await getPlatform().fs.remove(path).catch(() => {});
    // Explorer and open editors follow at once (the file watcher would, a moment later).
    await applyExternalChanges([...toWrite, ...plan.remoteChanges.deleted]);
    // The new base: Task Mentor's head, except conflicting files keep their old base so they stay conflicts.
    const oldBase = new Map((binding.base ?? []).map((f) => [f.path, f]));
    const base = remote.files.filter((f) => !plan.conflicts.includes(f.path)).concat(plan.conflicts.flatMap((p) => (oldBase.get(p) ? [oldBase.get(p)!] : [])));
    await writeBinding({ ...binding, base_revision_id: remote.head.id, base });
    set({ lastSyncAt: Date.now() });
    if (!opts.quiet) notify("info", toWrite.length + plan.remoteChanges.deleted.length ? `Updated ${toWrite.length + plan.remoteChanges.deleted.length} file(s) from Task Mentor.` : "This folder already has Task Mentor's latest files.");
  } catch (e) {
    if (!opts.quiet) notify("error", (e as Error).message);
  } finally {
    progress?.close();
    await checkSync();
  }
}

/** Conflict resolution per file: keep this folder's version or take Task Mentor's. */
export async function resolveConflict(path: string, keep: "mine" | "theirs") {
  const binding = get().binding;
  const host = getPlatform().account;
  if (!binding || !host) return;
  const remote = await headManifest(binding.project_id);
  const theirs = remote.files?.find((f) => f.path === path) ?? null;
  if (keep === "theirs") {
    if (theirs) {
      const res = await api<{ base64: string }>("GET", `/projects/${binding.project_id}/blobs/${theirs.sha256}`, undefined, { response: "base64" });
      await host.writeBlob(path, theirs.sha256, res.base64);
    } else await getPlatform().fs.remove(path).catch(() => {});
    await applyExternalChanges([path]);
  }
  // Either way the base for this file becomes Task Mentor's: "mine" then shows as a local change to save.
  const base = (binding.base ?? []).filter((f) => f.path !== path).concat(theirs ? [theirs] : []);
  await writeBinding({ ...binding, base });
  await checkSync();
}

// ── Open a project (Projects view, tmcode://project deep link) ────────────

async function openProjectNow(projectId: number, opts: { folderName?: string } = {}): Promise<boolean> {
  if (!projectsSupported()) return false;
  if (!(await requireSignIn())) return false;
  // Unsaved files first (Cancel keeps the open folder), not after cloning or downloading.
  if (!(await confirmLeaveWorkspace())) return false;
  const store = getPlatform().store;
  const folders = (await store.get<Record<string, string>>(FOLDERS_KEY)) ?? {};
  const known = folders[String(projectId)];
  if (known) {
    try {
      await (getPlatform().openPath ? openPathFromOs(known) : openRecent(known));
      if (useWorkbench.getState().workspace?.root === known) {
        await bindWorkspace();
        // Still this project's folder (not emptied, not disconnected and reconnected elsewhere)?
        if (get().binding?.project_id === projectId) {
          void showBriefOfCurrent(projectId);
          return true;
        }
      }
    } catch {
      /* moved or deleted: get a fresh copy */
    }
  }
  const { project } = await api<{ project: Project }>("GET", `/projects/${projectId}`);
  const host = getPlatform().account!;
  if (project.kind === "github") {
    const git = getPlatform().git;
    if (!git || !project.repo_url) {
      notify("error", "This GitHub project has no repository link, or git is not available.");
      return false;
    }
    await host.useProjectsFolderForClone?.();
    const progress = notifyProgress(`Cloning ${project.repo_full_name ?? project.name}…`);
    try {
      const path = await git.clone(project.repo_url, (e) => e.type === "progress" && progress.update({ message: `Cloning: ${e.line}` })).done;
      if (!(await openPathFromOs(path))) return false;
    } catch (e) {
      notify("error", `Could not clone the repository: ${(e as Error).message}`);
      return false;
    } finally {
      progress.close();
    }
    await writeBinding({ project_id: project.id, tm_api: get().account?.tm_api ?? "", kind: "github", name: project.name, base_revision_id: null, base: null });
  } else {
    const path = await host.newFolder(opts.folderName ?? project.slug);
    // The browser build (dev server, e2e) has no OS paths: its folders reopen like recent ones.
    // Kept the current folder: never bind or pull this project into it.
    if (!(await (getPlatform().openPath ? openPathFromOs(path) : openRecent(path)))) return false;
    await writeBinding({ project_id: project.id, tm_api: get().account?.tm_api ?? "", kind: "tm", name: project.name, base_revision_id: null, base: null });
    // A fresh folder: its files arriving is the point, not news.
    await pullFromTaskMentor({ quiet: true });
  }
  await rememberFolder(project.id);
  await bindWorkspace();
  void showBriefOfCurrent(projectId);
  return true;
}

/** An assignment's workspace opens with its brief beside the code (from Projects, Start or Continue alike). */
async function showBriefOfCurrent(projectId?: number) {
  // Binding the folder loads the project in the background: ask for it if it isn't here yet.
  let project = get().current;
  if (projectId && project?.id !== projectId) project = await api<{ project: Project }>("GET", `/projects/${projectId}`).then((r) => r.project).catch(() => null);
  const a = project?.assignment;
  if (!a) return;
  const shown = useWorkbench.getState().groups.some((g) => g.editors.some((e) => e.kind === "assignment" && e.assignmentId === a.id));
  if (!shown) (await import("./assignments")).showAssignment(a.id, { toSide: true });
}

/** Stop syncing the open folder: the binding goes, the files stay. */
export async function disconnectFolder() {
  const binding = get().binding;
  if (!binding) return;
  const choice = await showDialog({
    severity: "info",
    message: `Disconnect this folder from "${binding.name}"?`,
    detail: "TMCode stops syncing this folder with Task Mentor. Your files stay here, and the project stays in Task Mentor (delete it there if you no longer need it).",
    buttons: [
      { id: "disconnect", label: "Disconnect", primary: true, destructive: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "disconnect") return;
  void sendPresence(false);
  await getPlatform().fs.remove(BINDING).catch(() => {});
  const store = getPlatform().store;
  const map = (await store.get<Record<string, string>>(FOLDERS_KEY)) ?? {};
  delete map[String(binding.project_id)];
  await store.set(FOLDERS_KEY, map);
  applyReadOnly(null);
  set({ binding: null, current: null, plan: null, sync: "unbound", syncMessage: null });
  notify("info", "This folder is no longer synced with Task Mentor.");
}

/** Takes back a submission (servers with the project lifecycle) so the project is a draft again. */
async function withdrawSubmissionNow(projectId: number) {
  // A light confirmation: nothing is lost, but the teacher stops seeing the work.
  const links = get().current?.id === projectId ? get().current?.links : undefined;
  const version = Array.isArray(links) ? links.find((l) => l.status === "submitted")?.revision_number : null;
  const choice = await showDialog({
    severity: "info",
    message: "Withdraw your submission?",
    detail: `Your teacher won't see ${version ? `version ${version}` : "your work"} until you submit again.`,
    buttons: [
      { id: "withdraw", label: "Withdraw to Edit", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "withdraw") return false;
  try {
    const { project } = await api<{ project: Project }>("POST", `/projects/${projectId}/withdraw`, {});
    if (get().current?.id === projectId) {
      set({ current: { ...get().current!, ...project } });
      applyReadOnly(get().current);
    }
    notify("info", "Submission withdrawn: you can edit again. Submit when you are ready.");
    await recheck();
    void refreshProjects();
    return true;
  } catch (e) {
    notify("error", (e as Error).message);
    return false;
  }
}

/** Whether teachers' monitors see this project's live status (owners always see their own). */
export async function setSharePresence(projectId: number, share: boolean) {
  try {
    const { project } = await api<{ project: Project }>("PATCH", `/projects/${projectId}`, { share_presence: share });
    if (get().current?.id === projectId) set({ current: project });
    notify("info", share ? "Live status is shared with your teachers again." : "Live status is no longer shared with teachers.");
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

/** `tmcode://project?id=12&api=https://taskmentor-api.amashuri.com` from Task Mentor's "Open in TMCode". */
export function parseProjectLink(link: string): { id: number; api: string } | null {
  try {
    const u = new URL(link);
    if (u.protocol !== "tmcode:" || (u.hostname !== "project" && u.pathname.replace(/^\/+/, "") !== "project")) return null;
    const id = Number(u.searchParams.get("id"));
    const apiBase = u.searchParams.get("api") ?? "";
    if (!Number.isInteger(id) || id <= 0) return null;
    return { id, api: apiBase.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** Opens a project from a deep link; links for another Task Mentor than this account's are refused. */
export async function openProjectLink(link: { id: number; api: string }) {
  const { isAllowedApi } = await import("../exam/api");
  if (!isAllowedApi(link.api, !!getPlatform().exam?.dev)) return notify("error", "This link points to an unknown Task Mentor server and was ignored.");
  const account = get().account;
  if (account?.signed_in && account.tm_api.replace(/\/+$/, "") !== link.api) {
    return notify("error", `This project belongs to ${link.api}, but TMCode is signed in to ${account.tm_api}.`);
  }
  if (inExam()) return notify("info", "Finish your exam first: projects open outside exams.");
  await openProject(link.id);
}

// ── Activities (matching lives in matching.ts) ─────────────────────────

/** Soft-removes a project (status "removed"): its work stays on record and it can be restored. */
export async function removeProject(project: Project) {
  const choice = await showDialog({
    severity: "warning",
    message: `Remove "${project.name}"?`,
    detail: "It moves to Removed in Task Mentor: your saved versions stay on record and you can restore it. Files on this computer are not deleted.",
    buttons: [
      { id: "remove", label: "Remove", primary: true, destructive: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "remove") return false;
  try {
    await api("DELETE", `/projects/${project.id}`);
    notify("info", `"${project.name}" was removed. Restore it from Projects › Removed.`);
    if (get().binding?.project_id === project.id) await recheck();
    await refreshProjects();
    if (get().removed !== null) await loadRemoved();
    return true;
  } catch (e) {
    notify("error", (e as Error).message);
    return false;
  }
}

export async function restoreProject(projectId: number) {
  try {
    await api("POST", `/projects/${projectId}/restore`, {});
    notify("info", "Project restored: you can work on it again.");
    if (get().binding?.project_id === projectId) await recheck();
    await Promise.all([refreshProjects(), loadRemoved()]);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

/** The caller's removed projects (Projects › Removed), loaded on demand. */
export async function loadRemoved() {
  try {
    const res = await api<{ projects: Project[] }>("GET", "/projects?scope=mine&status=removed");
    set({ removed: res.projects });
  } catch (e) {
    set({ removed: [] });
    log("Projects", `Could not load removed projects: ${(e as Error).message}`);
  }
}

/** Submits the project to a linked activity (saves first so the newest work is what's submitted). */
async function submitLinkNow(projectId: number, linkId: number) {
  const binding = get().binding;
  if (binding?.project_id === projectId && binding.kind === "tm") {
    const locked = lockReason(get().current);
    if (locked) throw new Error(locked);
    if (isOffline()) throw new Error(saveFailureMessage(null, "submit"));
    lastSaveError = null;
    await saveToTaskMentor({ source: "submit", quiet: true });
    if (get().sync !== "synced") throw new Error(saveFailureMessage(lastSaveError, "submit"));
  }
  if (binding?.project_id === projectId && binding.kind === "github") {
    const st = useGit.getState().status;
    if (st && (st.ahead > 0 || st.entries.length > 0)) throw new Error("Commit and push your changes first: Task Mentor records the last pushed commit.");
    await reportGit();
  }
  const res = await api<{ link: Link; submission: unknown }>("POST", `/projects/${projectId}/links/${linkId}/submit`, {});
  await checkSync();
  return res;
}

// ── Live status: presence + git reports ───────────────────────────────────

async function deviceId(): Promise<string> {
  const store = getPlatform().store;
  let id = await store.get<string>(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await store.set(DEVICE_KEY, id);
  }
  return id;
}

async function sendPresence(open = true) {
  const binding = get().binding;
  if (!binding || !signedIn() || inExam() || !useWorkbench.getState().settings["projects.presence"]) return;
  const git = useGit.getState().status;
  const wb = useWorkbench.getState();
  const os = getPlatform().os;
  const state = {
    open,
    device_name: os === "mac" ? "Mac" : os === "windows" ? "Windows PC" : "Linux PC",
    file: open ? activeFilePath() : null,
    dirty: Object.keys(wb.dirty).length,
    branch: git?.branch ?? null,
    ahead: git?.ahead ?? null,
    behind: git?.behind ?? null,
    changes: git ? git.entries.length : get().plan ? changeCount(get().plan!.localChanges) : null,
    last_commit: git?.oid ?? null,
    last_run: wb.run.status === "idle" ? null : wb.run.label ?? null,
    sync: get().sync,
  };
  try {
    await api("PUT", `/projects/${binding.project_id}/presence`, { device_id: await deviceId(), app_version: getPlatform().version, state });
  } catch {
    /* offline: the next heartbeat tries again */
  }
}

let lastGitReport = "";
/** GitHub projects: Task Mentor shows the branch, ahead/behind and the last pushed commit. */
export async function reportGit() {
  const binding = get().binding;
  if (!binding || binding.kind !== "github" || !signedIn()) return;
  const st = useGit.getState().status;
  if (!st) return;
  const report = { branch: st.branch, head_commit: st.oid, ahead: st.ahead, behind: st.behind, changes: st.entries.length, remote_url: get().current?.repo_url ?? null };
  const key = JSON.stringify(report);
  if (key === lastGitReport) return;
  lastGitReport = key;
  try {
    await api("POST", `/projects/${binding.project_id}/git`, report);
  } catch {
    lastGitReport = "";
  }
}

let heartbeat: ReturnType<typeof setInterval> | null = null;
function startHeartbeats() {
  if (heartbeat) return;
  heartbeat = setInterval(() => void sendPresence(true), 20_000);
  setInterval(() => void reportGit(), 120_000);
  // After git operations (commit, push, pull) the status changes: report soon.
  let prev = useGit.getState().status;
  useGit.subscribe((s) => {
    if (s.status === prev) return;
    prev = s.status;
    setTimeout(() => void reportGit(), 1500);
  });
  // Auto save: after file saves (debounced), or on an interval.
  let lastDirty = 0;
  useWorkbench.subscribe((s) => {
    const n = Object.keys(s.dirty).length;
    if (n < lastDirty && s.settings["projects.autoSave"] === "onSave") scheduleAutoSave(4000);
    if (n !== lastDirty) scheduleCheck();
    lastDirty = n;
  });
  setInterval(() => {
    if (useWorkbench.getState().settings["projects.autoSave"] === "interval") scheduleAutoSave(0);
  }, 5 * 60_000);
  window.addEventListener("beforeunload", () => void sendPresence(false));
}

let autoTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoSave(delay: number) {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (get().binding?.kind === "tm" && signedIn() && !inExam()) void saveToTaskMentor({ source: "auto", quiet: true });
  }, delay);
}

let checkTimer: ReturnType<typeof setTimeout> | null = null;
/** Edits and saves change the sync badge: re-check shortly after. */
export function scheduleCheck(delay = 2500) {
  if (!get().binding || get().binding?.kind !== "tm") return;
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => void checkSync(), delay);
}

/** saveToTaskMentor, shown as activity from its first step: "Saving to Task Mentor…". */
export const saveToTaskMentor = (...args: Parameters<typeof saveToTaskMentorNow>) => track("Saving to Task Mentor…", () => saveToTaskMentorNow(...args));

/** pullFromTaskMentor, shown as activity from its first step: "Getting the latest from Task Mentor…". */
export const pullFromTaskMentor = (...args: Parameters<typeof pullFromTaskMentorNow>) => track("Getting the latest from Task Mentor…", () => pullFromTaskMentorNow(...args));

/** openProject, shown as activity from its first step: "Opening the project…". */
export const openProject = (...args: Parameters<typeof openProjectNow>) => track("Opening the project…", () => openProjectNow(...args));

/** withdrawSubmission, shown as activity from its first step: "Withdrawing the submission…". */
export const withdrawSubmission = (...args: Parameters<typeof withdrawSubmissionNow>) => track("Withdrawing the submission…", () => withdrawSubmissionNow(...args));

/** submitLink, shown as activity from its first step: "Submitting…". */
export const submitLink = (...args: Parameters<typeof submitLinkNow>) => track("Submitting…", () => submitLinkNow(...args));
