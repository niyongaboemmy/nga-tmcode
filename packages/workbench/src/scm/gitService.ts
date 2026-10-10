import { create } from "zustand";
import { executeCommand } from "../commands/registry";
import { onDocumentChanged, saveAll } from "../monaco/documents";
import { applyExternalChanges } from "../monaco/external";
import { inExam, useExam } from "../exam/state";
import type { GitCommit, GitHost, GitHubUser, GitInfo, GitRemoteOptions, GitStatus } from "../platform/types";
import {
  getPlatform,
  log,
  notify,
  notifyProgress,
  openFile,
  openPathFromOs,
  refreshExplorer,
  revealView,
  showDialog,
  showPanel,
  useWorkbench,
  workbench,
  type EditorInput,
} from "../state/store";
import { basename } from "../util/paths";
import { showInputBox, showQuickPick, type PickItem } from "../widgets/QuickPick";
import { classifyGitError, type GitErrorAction } from "./errors";
import { decorationsOf, discardPlan, groupsOf, validateBranchName, type Decoration, type Resource } from "./model";
import { ProgressTracker } from "./progress";
import { normalizeCloneUrl } from "./url";

/**
 * The Git service behind the Source Control view, the status bar, explorer
 * decorations and the gutter: one repository (the open folder's), refreshed
 * on saves, outside changes, window focus and after every operation.
 */

export type RemoteOp = "pull" | "push" | "sync" | "fetch" | "publish";

export interface GitState {
  info: GitInfo | null;
  /** null: the workspace isn't in a repository (or git is unavailable). */
  status: GitStatus | null;
  /** The first status for this folder has arrived (skeleton until then). */
  loaded: boolean;
  /** Bumped on every status refresh (diff bases and the gutter re-read). */
  version: number;
  /** A local operation is running ("Committing", "Staging"…). */
  busy: string | null;
  remoteOp: RemoteOp | null;
  message: string;
  decorations: Record<string, Decoration>;
  /** Ignored workspace paths (folders without the trailing "/"). */
  ignored: Record<string, true>;
  log: GitCommit[];
  user: GitHubUser | null;
}

const initial: GitState = {
  info: null,
  status: null,
  loaded: false,
  version: 0,
  busy: null,
  remoteOp: null,
  message: "",
  decorations: {},
  ignored: {},
  log: [],
  user: null,
};

export const useGit = create<GitState>(() => ({ ...initial }));
const set = useGit.setState;
const get = useGit.getState;

export const GIT_DOWNLOAD_URL = "https://git-scm.com/downloads";
export const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=TMCode";

function platformGit(): GitHost | undefined {
  try {
    return getPlatform().git;
  } catch {
    return undefined;
  }
}

/** Git is a practice-mode feature: never during exams or under an exam policy. */
export function gitAllowed(): boolean {
  return !!platformGit() && useWorkbench.getState().policy.mode === "practice" && !inExam() && !useExam.getState().quiz;
}

export function useGitAllowed(): boolean {
  const mode = useWorkbench((s) => s.policy.mode);
  const exam = useExam((s) => s.phase === "active" || s.phase === "locked" || s.phase === "submitting" || !!s.quiz);
  return !!platformGit() && mode === "practice" && !exam;
}

/** The host when git may be used now. */
export function gitHost(): GitHost | undefined {
  return gitAllowed() ? platformGit() : undefined;
}

export function hasRepo() {
  return gitAllowed() && !!get().status;
}

// ───────────────────────────── errors ─────────────────────────────

export function showGitError(e: unknown) {
  const err = classifyGitError(e);
  if (err.kind === "cancelled") return;
  const run: Record<GitErrorAction, () => void> = {
    signIn: () => void signInWithToken(),
    pull: () => void runRemote("pull"),
    showConflicts: () => revealView("scm"),
    publish: () => void runRemote("publish"),
    setIdentity: () => void configureIdentity(),
    stash: () => void stash("push"),
    installGit: () => platformGit()?.openExternal?.(GIT_DOWNLOAD_URL),
    showOutput: () => showPanel("output"),
  };
  notify(err.kind === "nothingToCommit" ? "info" : "error", err.message, err.actions.map((a) => ({ label: a.label, run: run[a.id] })));
}

// ───────────────────────────── refresh ─────────────────────────────

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing: Promise<void> | null = null;
let again = false;

export function scheduleRefresh(delay = 300) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshStatus();
  }, delay);
}

function reset() {
  ignoreChecked.clear();
  set({ status: null, loaded: false, decorations: {}, ignored: {}, log: [], busy: null, remoteOp: null });
}

export async function refreshStatus(): Promise<void> {
  const git = gitHost();
  const ws = useWorkbench.getState().workspace;
  if (!git || !ws) {
    if (get().status || get().loaded) reset();
    return;
  }
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      if (!get().info) set({ info: await git.info().catch(() => ({ installed: false, version: null, path: null })) });
      if (!get().info?.installed) {
        set({ status: null, loaded: true, decorations: {} });
        break;
      }
      const status = await git.status().catch((e) => {
        log("Git", String((e as Error)?.message ?? e), "error");
        return null;
      });
      if (useWorkbench.getState().workspace?.root !== ws.root || !gitAllowed()) break;
      const wasRepo = !!get().status;
      set({ status, loaded: true, version: get().version + 1, decorations: decorationsOf(status) });
      if (status) {
        const commits = await git.log(30).catch(() => []);
        set({ log: commits });
        if (!wasRepo) scheduleIgnoreCheck(0);
      } else set({ log: [], ignored: {} });
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function redetectGit() {
  const git = platformGit();
  if (!git) return;
  set({ info: await git.info(true).catch(() => null), loaded: false });
  await refreshStatus();
}

// ── ignored files (explorer dimming), checked per loaded folder ──

const ignoreChecked = new Set<string>();
let ignoreTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIgnoreCheck(delay = 250) {
  if (ignoreTimer) clearTimeout(ignoreTimer);
  ignoreTimer = setTimeout(() => void checkIgnored(), delay);
}

async function checkIgnored() {
  const git = gitHost();
  if (!git || !get().status) return;
  const dirs = useWorkbench.getState().dirs;
  const ask: string[] = [];
  for (const entries of Object.values(dirs)) {
    for (const e of entries) {
      if (ignoreChecked.has(e.path) || e.name === ".git") continue;
      ignoreChecked.add(e.path);
      ask.push(e.kind === "dir" ? `${e.path}/` : e.path);
    }
  }
  if (!ask.length) return;
  const hits = await git.checkIgnore(ask).catch(() => []);
  if (!hits.length) return;
  const ignored = { ...get().ignored };
  for (const h of hits) ignored[h.replace(/\/$/, "")] = true;
  set({ ignored });
}

// ───────────────────────────── wiring ─────────────────────────────

let wired = false;
export function wireGit() {
  if (wired) return;
  wired = true;
  const git = platformGit();
  if (!git) return;
  git.onLog((line) => log("Git", line));
  let root = useWorkbench.getState().workspace?.root ?? null;
  let allowed = gitAllowed();
  if (root && allowed) void refreshStatus();
  if (allowed) void loadUser();
  const recheck = () => {
    const nextRoot = useWorkbench.getState().workspace?.root ?? null;
    const nextAllowed = gitAllowed();
    if (nextRoot !== root || nextAllowed !== allowed) {
      root = nextRoot;
      allowed = nextAllowed;
      reset();
      set({ message: "" });
      if (root && allowed) void refreshStatus();
    }
  };
  useWorkbench.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace || s.policy !== prev.policy) recheck();
    if (s.dirs !== prev.dirs && get().status) scheduleIgnoreCheck();
  });
  useExam.subscribe(recheck);
  getPlatform().watch?.((paths) => {
    if (!gitAllowed()) return;
    if (paths.some((p) => p === ".gitignore" || p.endsWith("/.gitignore"))) {
      ignoreChecked.clear();
      set({ ignored: {} });
      scheduleIgnoreCheck(400);
    }
    scheduleRefresh(500);
  });
  git.onRepoChange?.(() => gitAllowed() && scheduleRefresh(200));
  // Saves (not keystrokes): the document is clean again.
  onDocumentChanged((path) => {
    if (gitAllowed() && !useWorkbench.getState().dirty[path]) scheduleRefresh(400);
  });
  window.addEventListener("focus", () => gitAllowed() && scheduleRefresh(0));
}

// ───────────────────────────── operations ─────────────────────────────

let queue: Promise<unknown> = Promise.resolve();

/** Runs one local git operation at a time (no index.lock races), then refreshes. */
async function op<T>(label: string, fn: (git: GitHost) => Promise<T>): Promise<T | undefined> {
  const git = gitHost();
  if (!git) return undefined;
  const run = queue.then(async () => {
    set({ busy: label });
    try {
      return { ok: true as const, value: await fn(git) };
    } catch (e) {
      showGitError(e);
      return { ok: false as const };
    } finally {
      set({ busy: null });
    }
  });
  queue = run.catch(() => {});
  const result = await run;
  await refreshStatus();
  return result.ok ? result.value : undefined;
}

/** Open editors follow the files git just rewrote (checkout, pull, discard, stash). */
async function syncEditorsWithDisk(force: string[] = []) {
  const s = useWorkbench.getState();
  const open = [...new Set(s.groups.flatMap((g) => g.editors.flatMap((e) => (e.kind === "file" || e.kind === "gitDiff" ? [e.path] : []))))];
  const { getDocument, markSaved } = await import("../monaco/documents");
  // Discarded files lose their unsaved edits too, as in VS Code.
  for (const p of force) {
    const model = getDocument(p);
    const disk = model ? await getPlatform().fs.readFile(p).catch(() => null) : null;
    if (model && disk !== null) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: disk }], () => null);
      markSaved(p);
    }
  }
  await applyExternalChanges(open);
  await refreshExplorer();
}

export const stage = (paths: string[]) => paths.length && op("Staging", (g) => g.stage(paths));
export const unstage = (paths: string[]) => paths.length && op("Unstaging", (g) => g.unstage(paths));

export async function stageResources(rs: Resource[]) {
  // Staging a file with unsaved edits stages what's on disk: save first, like VS Code.
  const dirty = rs.filter((r) => useWorkbench.getState().dirty[r.path]);
  if (dirty.length) await saveAll();
  await stage(rs.map((r) => r.path));
}

export async function discard(rs: Resource[]) {
  if (!rs.length) return;
  const { tracked, untracked } = discardPlan(rs);
  const one = rs.length === 1 ? basename(rs[0].path) : null;
  const choice = await showDialog(
    one && untracked.length
      ? {
          message: `Are you sure you want to DELETE '${one}'?`,
          detail: "This is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.",
          severity: "warning",
          buttons: [
            { id: "ok", label: "Delete File", primary: true },
            { id: "cancel", label: "Cancel" },
          ],
          cancelId: "cancel",
        }
      : {
          message: one ? `Are you sure you want to discard changes in '${one}'?` : `Are you sure you want to discard ALL changes in ${rs.length} files?`,
          detail: untracked.length ? `This is IRREVERSIBLE!\n${untracked.length} untracked file${untracked.length > 1 ? "s" : ""} will be DELETED.` : "This action is irreversible!",
          severity: "warning",
          buttons: [
            { id: "ok", label: one ? "Discard File" : `Discard All ${rs.length} Files`, primary: true },
            { id: "cancel", label: "Cancel" },
          ],
          cancelId: "cancel",
        },
  );
  if (choice !== "ok") return;
  await op("Discarding", (g) => g.discard(tracked, untracked));
  await syncEditorsWithDisk(tracked);
}

export type CommitKind = "commit" | "amend" | "commitPush" | "commitSync" | "all";

export async function commit(kind: CommitKind = "commit") {
  if (!gitHost() || get().busy) return;
  const g = groupsOf(get().status);
  let all = kind === "all";
  // Unsaved edits wouldn't be in the commit.
  const dirty = Object.keys(useWorkbench.getState().dirty);
  if (dirty.length) {
    const choice = await showDialog({
      message: `The following file${dirty.length > 1 ? "s have" : " has"} unsaved changes which won't be included in the commit if you proceed: ${dirty.map((d) => basename(d)).join(", ")}.`,
      detail: "Would you like to save them before committing?",
      severity: "warning",
      buttons: [
        { id: "save", label: dirty.length > 1 ? "Save All & Commit Changes" : "Save & Commit Changes", primary: true },
        { id: "commit", label: "Commit Changes" },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice === "cancel") return;
    if (choice === "save") {
      await saveAll();
      await refreshStatus();
    }
  }
  const fresh = groupsOf(get().status);
  if (!all && kind !== "amend" && fresh.staged.length === 0) {
    if (fresh.changes.length === 0 && g.changes.length === 0) {
      notify("info", "There are no changes to commit.");
      return;
    }
    const choice = await showDialog({
      message: "There are no staged changes to commit.",
      detail: "Would you like to stage all your changes and commit them directly?",
      severity: "warning",
      buttons: [
        { id: "yes", label: "Yes", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice !== "yes") return;
    all = true;
  }
  const message = get().message;
  if (!message.trim() && kind !== "amend") {
    notify("warning", "Please provide a commit message.");
    window.dispatchEvent(new CustomEvent("tmcode:scm-focus-input"));
    return;
  }
  const ok = await op("Committing", (git) => git.commit({ message, amend: kind === "amend", all }).then(() => true));
  if (!ok) return;
  set({ message: "" });
  if (kind === "commitPush") await runRemote("push");
  if (kind === "commitSync") await runRemote("sync");
}

const REMOTE_TITLE: Record<RemoteOp, string> = { pull: "Pulling", push: "Pushing", sync: "Synchronizing", fetch: "Fetching", publish: "Publishing branch" };

/** Pull / push / sync / fetch / publish with a progress notification and Cancel. */
export async function runRemote(kind: RemoteOp): Promise<boolean> {
  const git = gitHost();
  const status = get().status;
  if (!git || !status || get().remoteOp) return false;
  let opName: "pull" | "push" | "sync" | "fetch" = kind === "publish" ? "push" : kind;
  const options: GitRemoteOptions = {};
  if (kind === "publish" || ((kind === "push" || kind === "sync") && !status.upstream)) {
    if (!status.branch) {
      notify("warning", "Can't publish: HEAD is detached. Check out a branch first.");
      return false;
    }
    if (!status.remotes.length) {
      notify("warning", "Your repository has no remotes configured to publish to. Add one in a terminal: git remote add origin <url>", [
        { label: "Open Terminal", run: () => executeCommand("workbench.action.terminal.new") },
      ]);
      return false;
    }
    let remote = status.remotes.includes("origin") ? "origin" : status.remotes[0];
    if (status.remotes.length > 1) {
      const pick = await showQuickPick({ placeholder: `Pick a remote to publish the branch '${status.branch}' to:`, items: status.remotes.map((r) => ({ id: r, label: r, icon: "cloud" })) });
      if (!pick) return false;
      remote = pick.id;
    }
    Object.assign(options, { remote, branch: status.branch, set_upstream: true });
    opName = "push";
    kind = "publish";
  }
  if (kind === "pull" && !status.upstream) {
    showGitError(new Error("There is no tracking information for the current branch."));
    return false;
  }
  const tracker = new ProgressTracker();
  let step = REMOTE_TITLE[kind];
  let task: ReturnType<GitHost["remote"]> | null = null;
  const n = notifyProgress(`Git: ${step}…`, { cancel: () => task?.cancel() });
  set({ remoteOp: kind });
  try {
    task = git.remote(opName, options, (e) => {
      if (e.type === "step") {
        step = e.name;
        n.update({ message: `Git: ${step}…` });
      } else if (tracker.update(e.line)) {
        n.update({ message: `Git: ${step}… ${tracker.phase} ${tracker.overall}%`.trim(), progress: tracker.overall });
      }
    });
    await task.done;
    if (kind === "publish") notify("info", `Published branch '${status.branch}' to ${options.remote}.`);
    return true;
  } catch (e) {
    showGitError(e);
    return false;
  } finally {
    n.close();
    set({ remoteOp: null });
    await refreshStatus();
    if (kind === "pull" || kind === "sync") await syncEditorsWithDisk();
  }
}

/** Status bar sync button: publish when there's no upstream, else pull + push. */
export function syncOrPublish() {
  const s = get().status;
  if (!s) return;
  void runRemote(s.upstream ? "sync" : "publish");
}

export async function initRepository() {
  const git = gitHost();
  if (!git || !useWorkbench.getState().workspace) return;
  await op("Initializing", (g) => g.init());
  revealView("scm");
}

// ── branches ──

export async function checkoutBranch() {
  const git = gitHost();
  if (!git || !get().status) return;
  const current = get().status?.branch;
  const items: Promise<PickItem[]> = git.branches().then((list) => {
    const local = list.filter((b) => b.kind === "local");
    const remote = list.filter((b) => b.kind === "remote");
    return [
      { id: "+create", label: "Create new branch...", icon: "add", alwaysShow: true },
      { id: "+createFrom", label: "Create new branch from...", icon: "add", alwaysShow: true },
      ...local.map((b, i) => ({
        id: `local:${b.name}`,
        label: b.name,
        icon: b.name === current ? "check" : "git-branch",
        description: [b.commit, b.subject].filter(Boolean).join(" · "),
        separator: i === 0 ? "branches" : undefined,
      })),
      ...remote.map((b, i) => ({
        id: `remote:${b.name}`,
        label: b.name,
        icon: "cloud",
        description: [b.commit, b.subject].filter(Boolean).join(" · "),
        separator: i === 0 ? "remote branches" : undefined,
      })),
    ];
  });
  const pick = await showQuickPick({ placeholder: "Select a branch or tag to checkout", items, matchOnDescription: true });
  if (!pick) return;
  if (pick.id === "+create") return createBranch();
  if (pick.id === "+createFrom") return createBranchFrom();
  const [kind, ...rest] = pick.id.split(":");
  const name = rest.join(":");
  if (kind === "local" && name === current) return;
  if (kind === "remote") {
    const localName = name.replace(/^[^/]+\//, "");
    const existing = (await git.branches().catch(() => [])).some((b) => b.kind === "local" && b.name === localName);
    if (existing) await doCheckout(localName, {});
    else await doCheckout(name, { remote: true });
  } else await doCheckout(name, {});
}

async function doCheckout(name: string, o: { create?: boolean; from?: string; remote?: boolean }) {
  const done = await op(o.create ? "Creating branch" : "Checking out", (g) => g.checkout(name, o).then(() => true));
  if (done) await syncEditorsWithDisk();
}

async function askBranchName(): Promise<string | undefined> {
  const raw = await showInputBox({
    placeholder: "Branch name",
    prompt: "Please provide a new branch name",
    validate: (v) => validateBranchName(v.trim().replace(/\s+/g, "-")),
  });
  return raw === undefined ? undefined : raw.trim().replace(/\s+/g, "-");
}

export async function createBranch() {
  if (!gitHost() || !get().status) return;
  const name = await askBranchName();
  if (name) await doCheckout(name, { create: true });
}

export async function createBranchFrom() {
  const git = gitHost();
  if (!git || !get().status) return;
  const ref = await showQuickPick({
    placeholder: "Select a ref to create the branch from",
    items: git.branches().then((list) =>
      list.map((b, i, all) => ({
        id: b.name,
        label: b.name,
        icon: b.kind === "remote" ? "cloud" : "git-branch",
        description: b.commit,
        separator: i === 0 || all[i - 1].kind !== b.kind ? (b.kind === "remote" ? "remote branches" : "branches") : undefined,
      })),
    ),
  });
  if (!ref) return;
  const name = await askBranchName();
  if (name) await doCheckout(name, { create: true, from: ref.id });
}

export async function stash(action: "push" | "pop") {
  if (!gitHost() || !get().status) return;
  let message: string | undefined;
  if (action === "push") {
    message = await showInputBox({ placeholder: "Stash message", prompt: "Optionally provide a stash message" });
    if (message === undefined) return;
  } else await saveAll();
  const done = await op(action === "push" ? "Stashing" : "Popping stash", (g) => g.stash(action, message).then(() => true));
  if (done) await syncEditorsWithDisk();
}

export async function configureIdentity() {
  const git = gitHost();
  if (!git) return;
  const name = await showInputBox({ title: "Git identity (1/2)", placeholder: "Your Name", prompt: "The name recorded on your commits (git config --global user.name)", validate: (v) => (v.trim() ? null : "Please provide a name") });
  if (!name) return;
  const email = await showInputBox({ title: "Git identity (2/2)", placeholder: "you@example.com", prompt: "The email recorded on your commits (git config --global user.email)", validate: (v) => (/^\S+@\S+$/.test(v.trim()) ? null : "Please provide an email address") });
  if (!email) return;
  await op("Configuring", (g) => g.setIdentity(name.trim(), email.trim()));
  notify("info", `Git will sign your commits as ${name.trim()} <${email.trim()}>.`);
}

// ── clone ──

export async function cloneRepository(urlArg?: string) {
  const git = gitHost();
  if (!git) return;
  let url = urlArg ? normalizeCloneUrl(urlArg) : null;
  if (!url) {
    const items: PickItem[] = git.github ? [{ id: "github", label: "Clone from GitHub", icon: "github", alwaysShow: true }] : [];
    let typed = "";
    const pick = await showQuickPick({
      placeholder: "Provide repository URL or pick a repository source.",
      items,
      dynamicItems: (value) => {
        typed = value;
        const u = normalizeCloneUrl(value);
        return u ? [{ id: "url", label: `Clone from URL ${u}`, icon: "link" }] : [];
      },
    });
    if (!pick) return;
    url = pick.id === "github" ? await pickGitHubRepo() : normalizeCloneUrl(typed);
    if (!url) return;
  }
  const parent = await git.pickCloneParent().catch((e) => {
    showGitError(e);
    return null;
  });
  if (!parent) return;
  const tracker = new ProgressTracker();
  let task: ReturnType<GitHost["clone"]> | null = null;
  const n = notifyProgress(`Cloning git repository '${url}'…`, { cancel: () => task?.cancel() });
  let dest: string | null = null;
  try {
    task = git.clone(url, (e) => {
      if (e.type === "progress" && tracker.update(e.line)) n.update({ message: `Cloning git repository '${url}'… ${tracker.phase} ${tracker.overall}%`, progress: tracker.overall });
    });
    dest = await task.done;
  } catch (e) {
    showGitError(e);
  } finally {
    n.close();
  }
  if (!dest) return;
  await import("../trust/trust").then((m) => m.markCloned(dest!)).catch(() => {});
  if (!getPlatform().openPath) {
    notify("info", `Cloned into ${dest}.`);
    return;
  }
  const choice = await showDialog({
    message: "Would you like to open the cloned repository?",
    detail: dest,
    buttons: [
      { id: "open", label: "Open", primary: true },
      { id: "cancel", label: "Not Now" },
    ],
    cancelId: "cancel",
  });
  if (choice === "open") await openPathFromOs(dest);
}

async function pickGitHubRepo(): Promise<string | null> {
  const gh = gitHost()?.github;
  if (!gh) return null;
  if (!get().user && !(await signInWithToken())) return null;
  const pick = await showQuickPick({
    title: "Clone from GitHub",
    placeholder: "Repository name (type to search)",
    matchOnDescription: true,
    items: gh.repos().then((repos) =>
      repos.map((r) => ({ id: r.clone_url, label: r.full_name, icon: r.private ? "lock" : "repo", description: r.description ?? undefined })),
    ),
  });
  return pick ? pick.id : null;
}

// ── GitHub account ──

export async function loadUser() {
  const gh = platformGit()?.github;
  if (!gh) return;
  const user = await gh.user().catch(() => null);
  set({ user });
}

export async function signInWithToken(): Promise<GitHubUser | null> {
  const git = gitHost();
  const gh = git?.github;
  if (!gh) return null;
  const token = await showInputBox({
    title: "GitHub: Sign in with a Personal Access Token",
    placeholder: "ghp_… or github_pat_…",
    prompt: "Paste a GitHub personal access token (classic with the 'repo' scope, or fine-grained with Contents: Read and write). It is kept in your system keychain.",
    password: true,
    validate: (v) => (v.trim().length >= 20 && !/\s/.test(v.trim()) ? null : "That doesn't look like a personal access token"),
    links: git?.openExternal ? [{ label: "Create a token on GitHub…", run: () => git.openExternal?.(TOKEN_URL) }] : undefined,
  });
  if (!token) return null;
  const n = notifyProgress("Signing in to GitHub…");
  try {
    const user = await gh.signIn(token.trim());
    set({ user });
    notify("info", `Signed in to GitHub as ${user.login}.`);
    return user;
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e), [{ label: "Try Again", run: () => void signInWithToken() }]);
    return null;
  } finally {
    n.close();
  }
}

export async function signOut() {
  const gh = platformGit()?.github;
  const user = get().user;
  if (!gh || !user) return;
  const choice = await showDialog({
    message: `Sign out of GitHub (${user.login})?`,
    detail: "TMCode will forget the token stored in your system keychain. Git will fall back to your own credential helpers.",
    buttons: [
      { id: "out", label: "Sign Out", primary: true, destructive: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "out") return;
  await gh.signOut().catch((e) => notify("error", String((e as Error)?.message ?? e)));
  set({ user: null });
}

// ── editors ──

/** Opens a change the way VS Code does: a diff, or the file itself for untracked files and conflicts. */
export function openResource(r: Resource, opts: { pinned?: boolean } = {}) {
  if (r.untracked || r.group === "merge") {
    openFile(r.path, { pinned: opts.pinned });
    return;
  }
  openGitDiff(r.path, r.group === "index" ? "staged" : "working", r.deleted, opts.pinned);
}

export function openGitDiff(path: string, mode: "working" | "staged", deleted = false, pinned = false) {
  const s = workbench.get();
  const groupId = s.activeGroup;
  const input: EditorInput = { kind: "gitDiff", id: `git:${mode}:${path}`, path, mode, deleted, preview: !pinned };
  workbench.set({
    groups: s.groups.map((g) => {
      if (g.id !== groupId) return g;
      const existing = g.editors.find((e) => e.id === input.id);
      if (existing) return { ...g, editors: g.editors.map((e) => (e.id === input.id ? { ...input, preview: existing.preview && !pinned } : e)), activeId: input.id };
      const editors = [...g.editors];
      const previewIdx = editors.findIndex((e) => e.preview);
      if (previewIdx >= 0 && !(editors[previewIdx].kind === "file" && s.dirty[(editors[previewIdx] as { path: string }).path])) editors[previewIdx] = input;
      else editors.splice(editors.findIndex((e) => e.id === g.activeId) + 1, 0, input);
      return { ...g, editors, activeId: input.id };
    }),
  });
}

export function resetGitForTests() {
  set({ ...initial });
}
