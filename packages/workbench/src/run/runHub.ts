import { create } from "zustand";
import { executeCommand, formatKeybinding, registerCommand } from "../commands/registry";
import { debugAllowed, debugKindForPath, isDebugging, startDebugging, stopDebugging } from "../debug/debugService";
import { inExam, useExam } from "../exam/state";
import { getDocument, onDocumentChanged } from "../monaco/documents";
import type { OwnedTerminal, TerminalOwner } from "../parts/panel/TerminalView";
import { activateEditor, activeFilePath, getPlatform, log, notify, openEditorInput, openFile, showPanel, updateSetting, useWorkbench } from "../state/store";
import { pickAndRunTask } from "../tasks/service";
import { openBrowser, openExternalUrl } from "../terminal/browser";
import { claimServerPort } from "../terminal/enhance";
import { findLocalUrls, portOf } from "../terminal/links";
import { basename, dirname, extname } from "../util/paths";
import { showQuickPick, type PickItem } from "../widgets/QuickPick";
import { isJsConsoleRunning, runInJsConsole, stopJsConsole } from "./jsConsole";
import {
  PROJECT_FILES,
  actionAvailable,
  detectProjects,
  isRunLike,
  projectDirOf,
  resolveRun,
  type RunChoice,
  fileActions as fileActionsFor,
  shellLine,
  unavailableReason,
  type FolderSnapshot,
  type ProjectInfo,
  type RunAction,
  type TargetContext,
} from "./projectKind";
import { isRunning, openPreview, runFile, stopRun, writeConsole } from "./runService";
import { terminalAllowed } from "@tmcode/protocol";

/**
 * The Run hub: one place that knows how to run the open project or file.
 * The status bar's ▶ item, the editor title's split button, Run Project
 * (Ctrl/Cmd+Shift+F10) and Change Run Target… all go through here.
 * Dev servers run in a named terminal; the built-in browser opens when they
 * print their URL, and the ▶ turns into ■ Stop until they end.
 */

export type DevStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface DevSession {
  id: number;
  action: RunAction;
  status: DevStatus;
  url: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

export interface RunHubState {
  projects: ProjectInfo[];
  /** The last workspace scan (the Testing view finds test frameworks in it). */
  folders: FolderSnapshot[];
  /** Actions for the active file. */
  fileActions: RunAction[];
  scanning: boolean;
  /** Kept for the old API (unused): Run's choices are `pins`. */
  targetId: string | null;
  /** "Change Run Target…" choices, per project folder ("" = the root). */
  pins: Record<string, string>;
  /** Remembered editor-title choice per file extension ("js" → "jsConsole"). */
  fileChoice: Record<string, RunAction["kind"]>;
  session: DevSession | null;
}

export const useRunHub = create<RunHubState>()(() => ({ projects: [], folders: [], fileActions: [], scanning: false, targetId: null, pins: {}, fileChoice: {}, session: null }));
const set = useRunHub.setState;
const get = useRunHub.getState;

/** Ctrl/Cmd+F5 is Run Without Debugging and F10 is Step Over; Ctrl/Cmd+Shift+F10 is free. */
const RUN_PROJECT_KB = "mod+shift+f10";

// ───────────── what this host and session allow ─────────────

export function targetContext(): TargetContext {
  const p = getPlatform();
  const { policy } = useWorkbench.getState();
  const practice = !inExam() && policy.mode === "practice";
  const nativeRunner = !!p.runner?.interactive || p.kind === "desktop";
  return {
    practice,
    terminal: !!p.terminal && terminalAllowed(policy),
    // The browser build's runner only knows JavaScript.
    runner: (entry: string) => !!p.runner && (nativeRunner || /\.(m|c)?js$/i.test(entry)),
    debugger: debugAllowed() && !!p.debug,
    previewOrigin: !!p.preview,
  };
}

export function isAvailable(a: RunAction) {
  return actionAvailable(a, targetContext());
}

/** The exam task in front: its main file is what Run runs (resolveRun step 2). */
function taskInFront(): { entry: string; actions: RunAction[] } | null {
  if (!inExam()) return null;
  const e = useExam.getState();
  const task = e.tasks.find((t) => t.question_id === e.activeTask) ?? null;
  return task ? { entry: task.entry, actions: fileActionsFor(task.entry, { webRoot: null }) } : null;
}

/** What Run runs right now, and why (one answer for the status bar, the editor ▶, F5 and Ctrl+F5). */
export function currentRun(s: RunHubState = get()): RunChoice {
  return resolveRun({ projects: s.projects, file: s.fileActions, activePath: activeFilePath(), pins: s.pins, task: taskInFront(), ctx: targetContext() });
}

/** The Run target right now. */
export function currentTarget(s: RunHubState = get()): RunAction | null {
  return currentRun(s).action;
}

// ───────────── scanning the workspace ─────────────

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "out", ".tmcode", "bin", "obj"]);

async function snapshot(dir: string): Promise<FolderSnapshot> {
  const fs = getPlatform().fs;
  const entries = await fs.readDir(dir).catch(() => []);
  const files = entries.filter((e) => e.kind === "file").map((e) => e.name);
  const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.name);
  const read: Record<string, string> = {};
  await Promise.all(
    files
      .filter((f) => PROJECT_FILES.includes(f) || /\.(cs|fs)proj$/.test(f))
      .map(async (name) => {
        const path = dir ? `${dir}/${name}` : name;
        const text = getDocument(path)?.getValue() ?? (await fs.readFile(path).catch(() => ""));
        read[name] = text.slice(0, 8192);
      }),
  );
  return { dir, files, dirs, read };
}

let scanGen = 0;

/** Projects at the root and up to two folders down (client/, server/, apps/web…). */
export async function scanWorkspace() {
  if (!useWorkbench.getState().workspace) {
    set({ projects: [], folders: [], scanning: false });
    return;
  }
  const gen = ++scanGen;
  set({ scanning: true });
  const root = await snapshot("");
  const sub = (s: FolderSnapshot) => s.dirs.filter((d) => !SKIP.has(d) && !d.startsWith(".")).map((d) => (s.dir ? `${s.dir}/${d}` : d));
  const level1 = await Promise.all(sub(root).slice(0, 40).map(snapshot));
  const level2 = await Promise.all(level1.flatMap(sub).slice(0, 80).map(snapshot));
  if (gen !== scanGen) return;
  const folders = [root, ...level1, ...level2];
  set({ projects: detectProjects(folders), folders, scanning: false });
}

async function hasIndex(dir: string) {
  const list = useWorkbench.getState().dirs[dir] ?? (await getPlatform().fs.readDir(dir).catch(() => []));
  return list.some((e) => e.kind === "file" && e.name.toLowerCase() === "index.html");
}

/** The nearest folder at or above `dir` with an index.html. */
async function webRootFor(dir: string): Promise<string | null> {
  let d: string | null = dir;
  while (d !== null) {
    if (await hasIndex(d)) return d;
    d = d === "" ? null : dirname(d);
  }
  return null;
}

let fileGen = 0;
export async function refreshFileActions() {
  const path = activeFilePath();
  const gen = ++fileGen;
  if (!path) {
    set({ fileActions: [] });
    return;
  }
  const ext = extname(path);
  const webRoot = ["html", "htm", "css", "js", "jsx", "tsx"].includes(ext) ? await webRootFor(dirname(path)) : null;
  const source = ["js", "mjs", "cjs", "ts", "mts", "cts"].includes(ext) ? (getDocument(path)?.getValue() ?? (await getPlatform().fs.readFile(path).catch(() => ""))) : undefined;
  const kind = debugKindForPath(path);
  const debuggable = !!kind && !!getPlatform().debug?.kinds.includes(kind);
  // A script previews its page only when that page loads it (one index.html at the top must not turn every exercise into a preview).
  let pageLoadsFile: boolean | undefined;
  if (webRoot !== null && (ext === "js" || ext === "css")) {
    const page = await getPlatform().fs.readFile(webRoot ? `${webRoot}/index.html` : "index.html").catch(() => "");
    const rel = webRoot ? path.slice(webRoot.length + 1) : path;
    pageLoadsFile = page.includes(rel) || page.includes(basename(path));
  }
  if (gen !== fileGen) return;
  set({ fileActions: fileActionsFor(path, { webRoot, source, debuggable, pageLoadsFile }) });
}

/** Run File: the active file's own first runnable action (PHP, Ruby, SQL… included), not the project. */
export async function runActiveFile() {
  const path = activeFilePath();
  if (!path) return;
  const ctx = targetContext();
  const a = get().fileActions.find((x) => isRunLike(x) && !unavailableReason(x, ctx));
  if (a) return executeAction(a, { reason: "you chose Run File" });
  return runFile(path, { note: `Running ${basename(path)}.` });
}

/** The editor title's ▶: the same target as the status bar's Run (one Run). */
export function primaryFileAction(s: RunHubState = get()): RunAction | null {
  return currentRun(s).action;
}

// ───────────── remembering choices ─────────────

const pinsKey = (root: string) => `runPins:${root}`;

/** Change Run Target: remembered for the project folder the choice belongs to (null: forget the active file's). */
export function setRunTarget(id: string | null) {
  const s = get();
  const a = id ? [...s.projects.flatMap((p) => p.actions), ...s.fileActions].find((x) => x.id === id) : null;
  const path = activeFilePath();
  const dir = a ? projectDirOf(s.projects, a.kind === "runFile" || a.kind === "jsConsole" || a.kind === "debug" ? (a.entry ?? path ?? "") : a) : path ? projectDirOf(s.projects, path) : "";
  const pins = { ...s.pins };
  if (id) pins[dir] = id;
  else delete pins[dir];
  set({ pins, targetId: id });
  const root = useWorkbench.getState().workspace?.root;
  if (root) void getPlatform().store.set(pinsKey(root), pins);
}

function rememberFileChoice(a: RunAction) {
  const path = activeFilePath();
  if (!path || !["runFile", "jsConsole", "livePreview", "debug"].includes(a.kind)) return;
  const fileChoice = { ...get().fileChoice, [extname(path)]: a.kind };
  set({ fileChoice });
  void getPlatform().store.set("runFileChoice", fileChoice);
}

// ───────────── running an action ─────────────

function runInNamedTerminal(command: string, cwd: string, name: string, owner?: TerminalOwner) {
  showPanel("terminal");
  window.dispatchEvent(new CustomEvent("tmcode:new-terminal", { detail: { command, cwd, name, owner } }));
}

/** Opens a preview-like tab beside the code, or shows it where it already is. */
function openBeside(input: Parameters<typeof openEditorInput>[0]) {
  const where = useWorkbench.getState().groups.find((g) => g.editors.some((e) => e.id === input.id));
  openEditorInput(input, where ? { group: where.id } : { toSide: true });
}

/** Runs one action: the core of every ▶ in the hub. */
export async function executeAction(a: RunAction, opts: { remember?: boolean; reason?: string } = {}) {
  const reason = unavailableReason(a, targetContext());
  if (reason) {
    notify("info", `${a.label}: ${reason}.`);
    return;
  }
  if (opts.remember) rememberFileChoice(a);
  log("Run", `${a.kind}: ${a.label}${opts.reason ? ` (because ${opts.reason})` : ""}`);
  // One place to look: every run says in the Run panel what it is and why (terminal runs too).
  const note = opts.reason ? `Running ${a.label} because ${opts.reason}.` : `Running ${a.label}.`;
  if (a.kind !== "runFile") {
    writeConsole({ type: "clear" });
    writeConsole({ type: "info", text: `▶ ${note}${a.kind === "task" || a.kind === "devServer" || a.kind === "repl" ? " Its output is in the Terminal panel." : ""}` });
  }
  const os = getPlatform().os;
  switch (a.kind) {
    case "runFile":
      return runFile(a.entry!, { note });
    case "jsConsole":
      return runInJsConsole(a.entry!);
    case "livePreview":
      return openPreview(a.root ?? "", a.entry ?? "index.html", a.preview ?? "static");
    case "openBrowser": {
      const url = await getPlatform().preview!.publish(a.root ?? "", a.entry ?? "index.html", {}, { internet: useWorkbench.getState().policy.internet_in_preview });
      return openExternalUrl(url);
    }
    case "devServer":
      // Project scripts (npm run dev, manage.py…) run the folder author's code: ask once in a cloned folder.
      if (!(await import("../trust/trust").then((m) => m.ensureTrusted("Project scripts")))) return;
      return startDevServer(a);
    case "task":
      if (!(await import("../trust/trust").then((m) => m.ensureTrusted("Project scripts")))) return;
      return runInNamedTerminal(shellLine(a.command!, { prelude: a.prelude, os }), a.cwd ?? "", a.label);
    case "repl":
      return runInNamedTerminal(shellLine(a.command!, { os }), a.cwd ?? "", a.label);
    case "debug":
      if (a.entry && activeFilePath() !== a.entry) openFile(a.entry, { pinned: true });
      return startDebugging();
    case "pickTask":
      return pickAndRunTask();
    case "markdownPreview":
      if (a.entry && activeFilePath() !== a.entry) openFile(a.entry, { pinned: true });
      return executeCommand("markdown.showPreviewToSide");
    case "sqlRun": {
      const { runSql } = await import("../sql/service");
      if (a.entry && activeFilePath() !== a.entry) openFile(a.entry, { pinned: true });
      return runSql(a.entry!);
    }
    case "logicPreview":
      if (a.entry && activeFilePath() !== a.entry) openFile(a.entry, { pinned: true });
      return openBeside({ kind: "logic", id: `logic:${a.entry}`, path: a.entry!, preview: false });
  }
}

/** Run Project: the remembered target, or the best one; a running dev server is revealed instead of started twice. */
export async function runProject() {
  if (!useWorkbench.getState().workspace) return;
  if (!get().projects.length) await scanWorkspace();
  const { action, reason } = currentRun();
  if (!action) return pickRunTarget({ run: true });
  await executeAction(action, { reason });
}

// ───────────── dev servers ─────────────

/** Shows a server in the built-in browser, reusing a tab already open on it. */
export function revealBrowser(url: string) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw url */
  }
  for (const g of useWorkbench.getState().groups) {
    const tab = g.editors.find((e) => e.kind === "browser" && e.id === `browser:${host}`);
    if (tab) {
      activateEditor(g.id, tab.id);
      return;
    }
  }
  openBrowser(url);
}

let sessionSeq = 0;
let terminal: OwnedTerminal | null = null;
let restartAfterStop: RunAction | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;

const live = (s: DevSession | null) => !!s && (s.status === "starting" || s.status === "running" || s.status === "stopping");

export function devServerActive() {
  return live(get().session);
}

function patchSession(id: number, patch: Partial<DevSession>) {
  const s = get().session;
  if (s && s.id === id) set({ session: { ...s, ...patch } });
}

export async function startDevServer(a: RunAction) {
  const cur = get().session;
  if (cur && live(cur)) {
    if (cur.action.id === a.id) {
      if (cur.url) revealBrowser(cur.url);
      else terminal?.reveal();
      return;
    }
    restartAfterStop = a;
    stopDevServer();
    return;
  }
  const id = ++sessionSeq;
  terminal = null;
  set({ session: { id, action: a, status: "starting", url: null, startedAt: Date.now(), endedAt: null, exitCode: null } });
  let tail = "";
  const owner: TerminalOwner = {
    onReady: (h) => {
      if (get().session?.id === id) terminal = h;
      else h.kill();
    },
    onData: (d) => {
      const s = get().session;
      if (!s || s.id !== id || s.url) return;
      // Keep a little of the previous chunk: URLs can be split across writes.
      const text = (tail + d).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      tail = text.slice(-300);
      const url = findLocalUrls(text).find((u) => /:\d{2,5}/.test(u));
      if (!url) return;
      const port = portOf(url);
      if (port != null) claimServerPort(port);
      const pretty = url.replace(/\/\/(0\.0\.0\.0|\[::\]|127\.0\.0\.1)/, "//localhost");
      patchSession(id, { status: "running", url: pretty });
      if (slowTimer) clearTimeout(slowTimer);
      if (useWorkbench.getState().settings["run.openBrowserOnStart"]) revealBrowser(pretty);
      log("Run", `${a.label} is listening on ${pretty}`);
    },
    onExit: (code) => {
      const s = get().session;
      if (!s || s.id !== id) return;
      if (killTimer) clearTimeout(killTimer);
      if (slowTimer) clearTimeout(slowTimer);
      terminal = null;
      const asked = s.status === "stopping";
      const failed = !asked && (s.status === "starting" || (code !== 0 && code !== 130 && code !== null));
      patchSession(id, { status: failed ? "failed" : "stopped", endedAt: Date.now(), exitCode: code });
      const next = restartAfterStop;
      restartAfterStop = null;
      if (next) {
        void startDevServer(next);
        return;
      }
      if (failed) {
        notify("error", `${a.label} stopped${code != null ? ` with exit code ${code}` : ""} before it was ready.`, [
          { label: "Show Terminal", run: () => showPanel("terminal") },
          { label: "Run Again", run: () => void startDevServer(a) },
        ]);
      }
    },
    onError: (message) => {
      patchSession(id, { status: "failed", endedAt: Date.now() });
      notify("error", `${a.label} could not start: ${message}`);
    },
  };
  slowTimer = setTimeout(() => {
    const s = get().session;
    if (s?.id === id && s.status === "starting") {
      notify("info", `${a.label} is still starting… TMCode opens the browser as soon as it prints its address.`, [{ label: "Show Terminal", run: () => terminal?.reveal() }]);
    }
  }, 45_000);
  runInNamedTerminal(shellLine(a.command!, { prelude: a.prelude, os: getPlatform().os, exitAfter: true }), a.cwd ?? "", a.label, owner);
}

/** ■ Stop: Ctrl+C first (lets the server shut down cleanly), then kill. */
export function stopDevServer() {
  const s = get().session;
  if (!s || !live(s)) return;
  if (!terminal) {
    patchSession(s.id, { status: "stopped", endedAt: Date.now() });
    return;
  }
  patchSession(s.id, { status: "stopping" });
  terminal.write("\x03");
  const t = terminal;
  if (killTimer) clearTimeout(killTimer);
  killTimer = setTimeout(() => {
    if (get().session?.id === s.id && get().session?.status === "stopping") t.kill();
  }, 2500);
}

export function restartDevServer() {
  const s = get().session;
  if (!s) return;
  if (live(s)) {
    restartAfterStop = s.action;
    stopDevServer();
  } else void startDevServer(s.action);
}

export function showDevServerTerminal() {
  terminal?.reveal();
}

// ───────────── stop across every runner ─────────────

/** What is running now, for the status bar and the editor title. */
export function activity(): "dev" | "run" | "js" | null {
  if (devServerActive()) return "dev";
  if (isRunning()) return "run";
  if (isJsConsoleRunning()) return "js";
  return null;
}

/** True when Stop has something to stop: the debugger, a run, a dev server or the JS console. */
export function canStop() {
  return isDebugging() || activity() !== null;
}

/** The one Stop (Shift+F5, the Run panel, the editor ■, the status bar): the debugger first, then whatever runs. */
export function stopAnything() {
  if (isDebugging()) {
    void stopDebugging();
    return;
  }
  const what = activity();
  if (what === "dev") stopDevServer();
  else if (what === "run") stopRun();
  else if (what === "js") stopJsConsole();
}

// ───────────── Change Run Target… ─────────────

function pickItems(): PickItem[] {
  const s = get();
  const ctx = targetContext();
  const current = currentTarget(s);
  const items: PickItem[] = [];
  const add = (a: RunAction, group: string, first: boolean) => {
    const why = unavailableReason(a, ctx);
    items.push({
      id: a.id,
      label: a.label,
      icon: a.icon,
      description: why ?? (a.id === current?.id ? "current target" : (a.description ?? a.command)),
      detail: !why && a.command && a.description ? a.command : undefined,
      separator: first ? group : undefined,
    });
  };
  for (const p of s.projects) p.actions.forEach((a, i) => add(a, `${p.label}${p.dir ? ` · ${p.dir}` : ""}`, i === 0));
  const seen = new Set(items.map((i) => i.id));
  s.fileActions.filter((a) => !seen.has(a.id)).forEach((a, i) => add(a, "current file", i === 0));
  return items;
}

/** Fresh items: rescans first (a skeleton shows meanwhile), so new projects appear at once. */
async function freshItems(): Promise<PickItem[]> {
  await Promise.all([scanWorkspace(), refreshFileActions()]);
  return pickItems();
}

function actionById(id: string | undefined) {
  return [...get().projects.flatMap((p) => p.actions), ...get().fileActions].find((x) => x.id === id);
}

/** Picks the Run Project target (and remembers it for this folder). */
export async function pickRunTarget(opts: { run?: boolean } = {}) {
  const items = freshItems().then((list) =>
    list.length
      ? list
      : [{ id: "", label: "Nothing to run in this folder", description: "Open a file, or a project with package.json, pom.xml, Makefile, go.mod, Cargo.toml…", icon: "info", alwaysShow: true }],
  );
  const choice = await showQuickPick({ title: "Run Target", placeholder: "Select what Run Project starts", matchOnDescription: true, items });
  const a = actionById(choice?.id);
  if (!a) return;
  const why = unavailableReason(a, targetContext());
  if (why) {
    notify("info", `${a.label}: ${why}.`);
    return;
  }
  setRunTarget(a.id);
  if (opts.run) await executeAction(a);
}

/** Run… : every action for this file and the project, run straight away. */
export async function pickAndRun() {
  const choice = await showQuickPick({ title: "Run", placeholder: "Select what to run", matchOnDescription: true, items: freshItems() });
  const a = actionById(choice?.id);
  if (a) await executeAction(a, { remember: true });
}

export function runProjectKeybinding() {
  return formatKeybinding(RUN_PROJECT_KB, getPlatform().os);
}

// ───────────── wiring ─────────────

/** "Follow the active HTML file": an open live preview switches to the HTML file being edited. */
function followActiveFile(path: string | null) {
  if (!path || !/\.html?$/i.test(path) || !useWorkbench.getState().settings["livePreview.followActiveFile"]) return;
  const hasPreview = useWorkbench.getState().groups.some((g) => g.editors.some((e) => e.kind === "preview" && e.profile === "static"));
  if (!hasPreview) return;
  const back = useWorkbench.getState().activeGroup;
  openPreview(dirname(path), basename(path), "static");
  useWorkbench.setState({ activeGroup: back });
}

let wired = false;

export function wireRunHub() {
  if (wired) return;
  wired = true;
  registerRunHubCommands();

  let root: string | null = null;
  let dirs = useWorkbench.getState().dirs;
  let rescan: ReturnType<typeof setTimeout> | null = null;
  const scheduleScan = (ms = 600) => {
    if (rescan) clearTimeout(rescan);
    rescan = setTimeout(() => void scanWorkspace(), ms);
  };
  const onWorkspace = async (next: string | null) => {
    root = next;
    if (devServerActive()) stopDevServer();
    set({ projects: [], targetId: null, pins: {}, session: null });
    if (!next) return;
    const p = getPlatform();
    const pins = await p.store.get<Record<string, string>>(pinsKey(next)).catch(() => undefined);
    if (root !== next) return;
    set({ pins: pins && typeof pins === "object" ? pins : {} });
    void scanWorkspace();
  };
  void onWorkspace(useWorkbench.getState().workspace?.root ?? null);
  let activePath = activeFilePath();
  let policy = useWorkbench.getState().policy;
  useWorkbench.subscribe((s) => {
    const next = s.workspace?.root ?? null;
    if (next !== root) void onWorkspace(next);
    // Files created, renamed or deleted (the explorer reloads the folder).
    if (s.dirs !== dirs) {
      dirs = s.dirs;
      scheduleScan();
    }
    const path = activeFilePath(s);
    if (path !== activePath) {
      activePath = path;
      void refreshFileActions();
      followActiveFile(path);
    }
    if (s.policy !== policy) {
      policy = s.policy;
      // An exam began: dev servers are a practice-mode feature.
      if (s.policy.mode !== "practice" && devServerActive()) stopDevServer();
      set({});
    }
  });
  getPlatform().watch?.((paths) => {
    if (paths.some((p) => PROJECT_FILES.includes(basename(p)) || /\.(html?|csproj)$/.test(p))) scheduleScan(400);
  });
  let jsTimer: ReturnType<typeof setTimeout> | null = null;
  onDocumentChanged((path) => {
    if (PROJECT_FILES.includes(basename(path)) && !useWorkbench.getState().dirty[path]) scheduleScan();
    // The JS console vs Node choice depends on the code (does it read input?).
    if (path === activeFilePath() && /\.(m|c)?[jt]s$/.test(path)) {
      if (jsTimer) clearTimeout(jsTimer);
      jsTimer = setTimeout(() => void refreshFileActions(), 500);
    }
  });
  void refreshFileActions();
}

function registerRunHubCommands() {
  const hasWorkspace = () => !!useWorkbench.getState().workspace;
  const terminalOk = () => targetContext().terminal && targetContext().practice;
  const activeIs = (re: RegExp) => () => re.test(activeFilePath() ?? "");
  const sqlFile = () => /\.sql$/i.test(activeFilePath() ?? "");
  // The .sql file of the active editor, or of the active SQL results tab (re-run from the results).
  const sqlTarget = () => {
    const p = activeFilePath();
    if (p && /\.sql$/i.test(p)) return p;
    const s = useWorkbench.getState();
    const g = s.groups.find((x) => x.id === s.activeGroup);
    const e = g?.editors.find((x) => x.id === g.activeId);
    return e?.kind === "sqlResults" ? e.path : null;
  };
  registerCommand({ id: "sql.runFile", title: "Run SQL File", category: "SQL", keybinding: "mod+shift+enter", enabled: () => !!sqlTarget(), run: async () => (await import("../sql/service")).runSql(sqlTarget()!) });
  registerCommand({ id: "sql.runStatement", title: "Run SQL Statement at Cursor (or Selection)", category: "SQL", keybinding: "mod+enter", enabled: sqlFile, run: async () => (await import("../sql/service")).runSql(activeFilePath()!, { scope: "statement" }) });
  registerCommand({ id: "api.openTester", title: "Open API Tester", category: "Run", enabled: () => !!getPlatform().http, run: async () => (await import("../api/service")).openApiTester() });
  registerCommand({ id: "sql.resetDatabase", title: "Reset SQL Database", category: "SQL", run: async () => (await import("../sql/service")).resetDatabase() });
  registerCommand({
    id: "logic.showTruthTables",
    title: "Show Truth Tables",
    category: "Logic",
    enabled: () => /\.logic$/i.test(activeFilePath() ?? ""),
    run: () => {
      const p = activeFilePath()!;
      openBeside({ kind: "logic", id: `logic:${p}`, path: p, preview: false });
    },
  });
  registerCommand({ id: "tmcode.runProject", title: "Run Project", category: "Run", keybinding: RUN_PROJECT_KB, enabled: hasWorkspace, run: runProject });
  registerCommand({ id: "tmcode.selectRunTarget", title: "Change Run Target...", category: "Run", enabled: hasWorkspace, run: () => pickRunTarget() });
  registerCommand({ id: "tmcode.runPick", title: "Run...", category: "Run", enabled: hasWorkspace, run: pickAndRun });
  // Hidden alias kept for menus and extensions; the one Stop is `tmcode.stop` (Shift+F5).
  registerCommand({ id: "tmcode.stopProject", title: "Stop Project", category: "Run", hidden: true, enabled: () => activity() === "dev" || activity() === "js", run: stopAnything });
  registerCommand({ id: "tmcode.restartProject", title: "Restart Project", category: "Run", enabled: () => !!get().session, run: restartDevServer });
  registerCommand({
    id: "tmcode.runInJsConsole",
    title: "Run File in JavaScript Console",
    category: "Run",
    enabled: activeIs(/\.(m|c)?[jt]s$/i),
    run: () => {
      const path = activeFilePath();
      if (path) void runInJsConsole(path);
    },
  });
  registerCommand({ id: "tmcode.jsConsole.show", title: "Show JavaScript Console", category: "View", run: () => showPanel("jsConsole") });
  registerCommand({
    id: "tmcode.livePreview",
    title: "Show Live Preview",
    category: "Run",
    enabled: activeIs(/\.html?$/i),
    run: () => {
      const path = activeFilePath();
      if (path) openPreview(dirname(path), basename(path), "static");
    },
  });
  registerCommand({
    id: "tmcode.livePreview.toggleFollow",
    title: "Live Preview: Toggle Follow Active HTML File",
    category: "Run",
    run: () => updateSetting("livePreview.followActiveFile", !useWorkbench.getState().settings["livePreview.followActiveFile"]),
  });
  const os = () => getPlatform().os;
  registerCommand({ id: "tmcode.repl.node", title: "Open Node.js REPL", category: "Run", enabled: terminalOk, run: () => runInNamedTerminal("node", "", "Node.js REPL") });
  registerCommand({ id: "tmcode.repl.python", title: "Open Python REPL", category: "Run", enabled: terminalOk, run: () => runInNamedTerminal(shellLine("python", { os: os() }), "", "Python REPL") });
}
