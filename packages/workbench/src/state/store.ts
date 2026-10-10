import { create } from "zustand";
import { PRACTICE_POLICY, type Policy } from "@tmcode/protocol";
import type { DirEntry, Platform } from "../platform/types";
import { basename, dirname, isWithin, join, rebase } from "../util/paths";
import { DEFAULT_SETTINGS, type SettingKey, type Settings } from "./settings";
import { isExamRoot } from "../exam/roots";

/** `ext:<id>`: a view container contributed by an extension (exthost/views). */
export type ViewId = "explorer" | "search" | "testing" | "task" | "scm" | "debug" | "extensions" | "projects" | "assignments" | "grading" | `ext:${string}`;
export type PanelId = "problems" | "output" | "run" | "terminal" | "debugConsole" | "jsConsole" | `ext:${string}`;

export type EditorInput =
  | { kind: "file"; id: string; path: string; preview: boolean }
  | { kind: "settings"; id: "settings"; preview: false }
  | { kind: "welcome"; id: "welcome"; preview: false }
  | { kind: "shortcuts"; id: "shortcuts"; preview: false }
  /** Web preview of a folder (`root`), showing `entry` (e.g. index.html). */
  | { kind: "preview"; id: string; root: string; entry: string; profile: "static" | "bundle-react"; preview: false }
  /** Expected vs actual output of one visible test. */
  | { kind: "testDiff"; id: string; testId: string; preview: false }
  /** Simple Browser on a local dev server (Vite, Next, Angular, Spring…). */
  | { kind: "browser"; id: string; url: string; preview: false }
  /** Rendered Markdown beside its source, live while typing. */
  | { kind: "markdown"; id: string; path: string; preview: false }
  /** Rendered image beside its source (SVG). Binary images open as ordinary "file" editors. */
  | { kind: "image"; id: string; path: string; preview: false }
  /** Git: HEAD/index (left) vs index/working tree (right) of one file (scm/GitDiffEditor). */
  | { kind: "gitDiff"; id: string; path: string; mode: "working" | "staged"; deleted: boolean; preview: boolean }
  /** Local History: a saved copy (left, read-only) against the file now (right, editable). */
  | { kind: "historyDiff"; id: string; path: string; entry: string; time: number; preview: false; /** "taskMentor": `entry` is the path of Task Mentor's copy of a conflicting file (projects compareConflict). "grading": `entry` is "<project>@<revision>" of a version (grading/diff.ts), named by `label`. */ source?: "taskMentor" | "grading"; label?: string }
  /** A Task Mentor assignment / case study: brief, state, Start / Submit (projects/AssignmentEditor). */
  | { kind: "assignment"; id: string; assignmentId: number; title: string; preview: false }
  /** Grading one assignment / quiz practical question (grading/GradingEditor). */
  | { kind: "grading"; id: string; gradingKey: string; title: string; preview: false }
  /** Results of running a .sql file (sql/SqlResultsEditor). */
  | { kind: "sqlResults"; id: string; path: string; preview: false }
  /** Truth tables of a .logic file (logic/LogicEditor). */
  | { kind: "logic"; id: string; path: string; preview: false }
  /** The API Tester (api/ApiTester). */
  | { kind: "api"; id: string; preview: false }
  /** Details of a VS Code extension ("extension:<publisher.name>"). */
  | { kind: "extension"; id: string; extensionId: string; preview: false }
  /** An extension's webview panel ("webview:<handle>", exthost/views/webviews.ts). */
  | { kind: "webview"; id: string; handle: string; preview: false };

export type TestStatus = "idle" | "queued" | "running" | "passed" | "failed" | "error";

export interface TestItem {
  id: string;
  name: string;
  input: string;
  expected_output: string;
  status: TestStatus;
  actual?: string;
  stderr?: string;
  message?: string;
  duration_ms?: number;
}

export interface RunState {
  status: "idle" | "building" | "running";
  entry: string | null;
  /** Label shown in the Run panel title, e.g. "Python 3: main.py". */
  label: string | null;
  lastExit: { code: number | null; timed_out: boolean; killed: boolean; duration_ms: number } | null;
  /** Arguments / input file of the last run ("Run Again" repeats them). */
  args?: string[];
  inputFile?: string | null;
  /** When the current run (or its run step) started, for the elapsed-time readout. */
  startedAt?: number;
}

export interface EditorGroup {
  id: number;
  editors: EditorInput[];
  activeId: string | null;
}

export interface Problem {
  path: string;
  message: string;
  severity: "error" | "warning" | "info";
  line: number;
  column: number;
  source?: string;
}

export interface Notification {
  id: number;
  severity: "info" | "warning" | "error";
  message: string;
  actions?: { label: string; run: () => void }[];
  /** A long operation: percentage, or null while it can't be measured (infinite bar). */
  progress?: number | null;
  /** Shows a Cancel button on a progress notification. */
  cancel?: () => void;
}

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
  /** Hard to undo (sign out everywhere, disconnect, remove): Cancel gets the focus, so Enter can't confirm it by accident. */
  destructive?: boolean;
}

export interface DialogRequest {
  message: string;
  detail?: string;
  severity?: "info" | "warning";
  buttons: DialogButton[];
  cancelId: string;
  resolve: (id: string) => void;
}

/** Inline name entry in the explorer (new file/folder, rename). */
export interface ExplorerEdit {
  mode: "newFile" | "newFolder" | "rename";
  /** Parent folder for new entries, the renamed path for rename. */
  target: string;
  error?: string | null;
}

export type QuickInputMode = "files" | "commands" | "line" | "theme" | "iconTheme";

export interface OutputLine {
  t: number;
  channel: string;
  text: string;
  level: "info" | "warn" | "error";
}

export interface WorkbenchState {
  ready: boolean;
  workspace: { name: string; root: string } | null;
  recent: { name: string; root: string }[];
  policy: Policy;

  dirs: Record<string, DirEntry[]>;
  expanded: Record<string, true>;
  selection: string | null;
  explorerEdit: ExplorerEdit | null;

  groups: EditorGroup[];
  activeGroup: number;
  dirty: Record<string, true>;

  sidebarVisible: boolean;
  activeView: ViewId;
  panelVisible: boolean;
  panelMaximized: boolean;
  activePanel: PanelId;

  settings: Settings;
  /** Theme shown while the theme picker is open (live preview). */
  previewTheme: Settings["workbench.colorTheme"] | null;
  /** File icon theme shown while its picker is open. */
  previewIconTheme: string | null;

  cursor: { line: number; column: number; selected: number };
  activeLanguage: string | null;
  eol: "LF" | "CRLF";

  problems: Problem[];
  output: OutputLine[];
  notifications: Notification[];
  dialog: DialogRequest | null;
  quickInput: { mode: QuickInputMode; initial?: string } | null;
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;

  run: RunState;
  /** Window size class: xs < 640px, sm < 900px, md < 1200px, lg otherwise. */
  viewport: "xs" | "sm" | "md" | "lg";
  /** Editors are read-only (exam time is up or submitted). */
  readOnly: boolean;
  /** Why the editor is read-only (shown when typing is refused); null = the exam's time is up. */
  readOnlyReason: string | null;
  tests: { entry: string | null; items: TestItem[]; running: boolean; source: string | null };
}

export type ContextMenuItem =
  | { kind: "item"; label: string; keybinding?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { kind: "separator" };

let platform: Platform | null = null;
export function getPlatform(): Platform {
  if (!platform) throw new Error("Workbench platform not initialised");
  return platform;
}

let notificationSeq = 0;
let groupSeq = 1;

const initialState: WorkbenchState = {
  ready: false,
  workspace: null,
  recent: [],
  policy: PRACTICE_POLICY,
  dirs: {},
  expanded: {},
  selection: null,
  explorerEdit: null,
  groups: [{ id: 0, editors: [], activeId: null }],
  activeGroup: 0,
  dirty: {},
  sidebarVisible: true,
  activeView: "explorer",
  panelVisible: false,
  panelMaximized: false,
  activePanel: "terminal",
  settings: DEFAULT_SETTINGS,
  previewTheme: null,
  previewIconTheme: null,
  cursor: { line: 1, column: 1, selected: 0 },
  activeLanguage: null,
  eol: "LF",
  problems: [],
  output: [],
  notifications: [],
  dialog: null,
  quickInput: null,
  contextMenu: null,
  run: { status: "idle", entry: null, label: null, lastExit: null },
  readOnly: false,
  readOnlyReason: null,
  viewport: "lg",
  tests: { entry: null, items: [], running: false, source: null },
};

/** Persisted between launches (per user, not per workspace). */
interface PersistedUi {
  settings?: Partial<Settings>;
  recent?: { name: string; root: string }[];
  layout?: { sidebarVisible: boolean; panelVisible: boolean; activePanel: PanelId };
}

export const useWorkbench = create<WorkbenchState>()(() => ({ ...initialState }));
const set = useWorkbench.setState;
const get = useWorkbench.getState;

function persist() {
  const s = get();
  const ui: PersistedUi = {
    settings: s.settings,
    recent: s.recent,
    layout: { sidebarVisible: s.sidebarVisible, panelVisible: s.panelVisible, activePanel: s.activePanel },
  };
  void platform?.store.set("ui", ui);
}

// ───────────────────────────── lifecycle ─────────────────────────────

export async function initWorkbench(p: Platform, opts: { autoOpenLast?: boolean } = {}) {
  platform = p;
  const ui = (await p.store.get<PersistedUi>("ui")) ?? {};
  set({
    settings: { ...DEFAULT_SETTINGS, ...ui.settings },
    // Exam folders never reopen from Recent (older versions listed them).
    recent: (ui.recent ?? []).filter((r) => !isExamRoot(r.root)),
    sidebarVisible: ui.layout?.sidebarVisible ?? true,
    panelVisible: ui.layout?.panelVisible ?? false,
    activePanel: ui.layout?.activePanel ?? "terminal",
  });
  // The colour theme is ready before the first paint (no flash of the default theme).
  await startupHooks.beforeReady();
  const last = get().recent[0];
  if (opts.autoOpenLast && last) {
    const ws = await p.reopenFolder(last.root).catch(() => null);
    if (ws) await setWorkspace(ws);
  }
  if (!get().workspace) openSpecialEditor("welcome");
  set({ ready: true });
}

/** Set by modules the store must not import (themes, extensions), run during initWorkbench. */
export const startupHooks: { beforeReady: () => Promise<void> } = { beforeReady: async () => {} };

export function resetWorkbenchForTests() {
  platform = null;
  groupSeq = 1;
  set({ ...initialState }, true);
}

/**
 * Before the open folder changes: Save / Don't Save / Cancel for unsaved files,
 * as VS Code does. False = keep this folder (Cancel, or a save failed). Ask
 * *before* the host switches folders (reopenFolder / openPath point the file
 * system at the new root), and before slow work such as cloning or downloading.
 */
export async function confirmLeaveWorkspace(): Promise<boolean> {
  const dirtyPaths = Object.keys(get().dirty);
  if (!dirtyPaths.length) return true;
  const choice = await confirmCloseDirty(dirtyPaths).catch(() => "cancel" as const);
  if (choice === "cancel") return false;
  if (choice === "discard") for (const p of dirtyPaths) await saveHandlers.discard(p);
  return !Object.keys(get().dirty).length;
}

/** Saves every unsaved file without asking (exam start: the launch ticket is already used, so no Cancel). */
export async function saveDirtyFiles() {
  for (const p of Object.keys(get().dirty)) await saveHandlers.save(p).catch(() => {});
}

/**
 * Shows a folder the host has opened. Returns false when the student chose
 * Cancel on the unsaved files prompt: the old folder stays, and callers stop.
 */
export async function setWorkspace(ws: { name: string; root: string }): Promise<boolean> {
  const prev = get().workspace;
  if (Object.keys(get().dirty).length) {
    // Asked late: the host already points at the new folder. Point it back while
    // saving, so the old files are written where they belong.
    const moved = !!prev && prev.root !== ws.root;
    if (moved) await getPlatform().reopenFolder(prev.root).catch(() => null);
    if (!(await confirmLeaveWorkspace())) return false;
    if (moved && !(await getPlatform().reopenFolder(ws.root).catch(() => null))) return false;
  }
  // Exam folders stay out of Recent: they must only open through Task Mentor.
  const others = get().recent.filter((r) => r.root !== ws.root && !isExamRoot(r.root));
  const recent = (isExamRoot(ws.root) ? others : [ws, ...others]).slice(0, 10);
  set({
    workspace: ws,
    recent,
    dirs: {},
    expanded: {},
    selection: null,
    groups: [{ id: 0, editors: [], activeId: null }],
    activeGroup: 0,
    dirty: {},
    problems: [],
  });
  // The old folder's documents go: B's main.py must never show (or save over) A's.
  workspaceListeners.forEach((l) => l());
  persist();
  await loadDir("");
  log("Workspace", `Opened ${ws.name}`);
  await restoreEditors(ws.root);
  return true;
}

const workspaceListeners = new Set<() => void>();
/** Fires when a folder is opened, right after the editors were reset (documents drop every model). */
export function onWorkspaceChanged(l: () => void) {
  workspaceListeners.add(l);
  return () => workspaceListeners.delete(l);
}

// ── open editors per folder (restored when the folder is opened again, as in VS Code) ──

const editorsKey = (root: string) => `editors:${root}`;

async function restoreEditors(root: string) {
  if (root.startsWith("memory://exam") || !platform) return;
  const saved = await platform.store.get<{ paths: string[]; active: string | null }>(editorsKey(root)).catch(() => undefined);
  if (!saved?.paths?.length) return;
  for (const path of saved.paths) {
    const exists = await platform.fs.readFile(path).then(() => true).catch(() => false);
    if (exists) openFile(path, { pinned: true });
  }
  if (saved.active && saved.paths.includes(saved.active)) openFile(saved.active, { pinned: true });
}

let editorsTimer: ReturnType<typeof setTimeout> | null = null;
useWorkbench.subscribe((s, prev) => {
  if (!s.workspace || (s.groups === prev.groups && s.activeGroup === prev.activeGroup)) return;
  if (editorsTimer) clearTimeout(editorsTimer);
  editorsTimer = setTimeout(() => {
    const st = get();
    if (!st.workspace || !platform) return;
    const paths = [...new Set(st.groups.flatMap((g) => g.editors.flatMap((e) => (e.kind === "file" && !e.preview ? [e.path] : []))))].slice(0, 30);
    void platform.store.set(editorsKey(st.workspace.root), { paths, active: activeFilePath(st) });
  }, 500);
});

// The open* functions return false when nothing was opened: the picker was
// closed, the path failed, or the student kept the current folder (Cancel on
// unsaved files). Callers that then write files must stop there.

export async function openFolder(): Promise<boolean> {
  if (!(await confirmLeaveWorkspace())) return false;
  const ws = await getPlatform().openFolder();
  return ws ? setWorkspace(ws) : false;
}

export async function openFileDialog(): Promise<boolean> {
  const p = getPlatform();
  if (!p.openFile) return openFolder();
  // The picked file may sit in another folder, which the host opens straight away.
  if (!(await confirmLeaveWorkspace())) return false;
  const ws = await p.openFile().catch((e) => {
    notify("error", String((e as Error)?.message ?? e));
    return null;
  });
  if (!ws) return false;
  if (get().workspace?.root !== ws.root && !(await setWorkspace(ws))) return false;
  if (ws.file) openFile(ws.file, { pinned: true });
  return true;
}

/** Inside the open folder (an OS path): opening it doesn't change folders. */
function insideWorkspace(path: string) {
  const root = get().workspace?.root;
  if (!root) return false;
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWithin(norm(path), norm(root));
}

/** Opens an absolute path from the command line, a second launch or "Open With". */
export async function openPathFromOs(path: string): Promise<boolean> {
  const p = getPlatform();
  if (!p.openPath) return false;
  if (!insideWorkspace(path) && !(await confirmLeaveWorkspace())) return false;
  try {
    const ws = await p.openPath(path);
    if (get().workspace?.root !== ws.root && !(await setWorkspace(ws))) return false;
    if (ws.file) openFile(ws.file, { pinned: true });
    return true;
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
    return false;
  }
}

export async function openRecent(root: string): Promise<boolean> {
  if (get().workspace?.root !== root && !(await confirmLeaveWorkspace())) return false;
  const ws = await getPlatform().reopenFolder(root).catch((e) => {
    notify("error", `Could not open '${root}': ${String(e?.message ?? e)}`);
    return null;
  });
  if (ws) return setWorkspace(ws);
  set({ recent: get().recent.filter((r) => r.root !== root) });
  return false;
}

// ───────────────────────────── explorer ─────────────────────────────

function sortEntries(entries: DirEntry[]) {
  return [...entries].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export async function loadDir(path: string) {
  try {
    // TMCode's own state (.tmcode: project binding, local history) stays out of sight, like VS Code's.
    const entries = (await getPlatform().fs.readDir(path)).filter((e) => !(path === "" && e.name === ".tmcode"));
    set({ dirs: { ...get().dirs, [path]: sortEntries(entries) } });
  } catch (e) {
    notify("error", `Unable to read folder '${path || "/"}': ${String((e as Error)?.message ?? e)}`);
  }
}

export async function refreshExplorer() {
  const loaded = Object.keys(get().dirs);
  await Promise.all(loaded.map((d) => loadDir(d)));
}

export async function toggleDir(path: string, open?: boolean) {
  const isOpen = !!get().expanded[path];
  const next = open ?? !isOpen;
  const expanded = { ...get().expanded };
  if (next) expanded[path] = true;
  else delete expanded[path];
  set({ expanded, selection: path });
  if (next && !get().dirs[path]) await loadDir(path);
}

export function collapseAll() {
  set({ expanded: {} });
}

export function select(path: string | null) {
  set({ selection: path });
}

/** Folder new entries go into: the selected folder, or the selected file's folder. */
export function targetFolder(): string {
  const { selection, dirs } = get();
  if (selection == null) return "";
  const isDir = Object.values(dirs).some((list) => list.some((e) => e.path === selection && e.kind === "dir"));
  return isDir ? selection : dirname(selection);
}

export async function beginExplorerEdit(edit: ExplorerEdit) {
  if (edit.mode !== "rename" && edit.target) await toggleDir(edit.target, true);
  set({ explorerEdit: { ...edit, error: null }, sidebarVisible: true, activeView: "explorer" });
}

export function cancelExplorerEdit() {
  set({ explorerEdit: null });
}

export function setExplorerEditError(error: string | null) {
  const e = get().explorerEdit;
  if (e) set({ explorerEdit: { ...e, error } });
}

async function ensureParents(path: string) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    const parent = dirname(dir);
    const known = get().dirs[parent] ?? (await getPlatform().fs.readDir(parent));
    if (!known.some((e) => e.path === dir)) await getPlatform().fs.createDir(dir);
  }
}

export async function createEntry(parent: string, name: string, kind: "file" | "dir") {
  const path = join(parent, name.trim());
  await ensureParents(path);
  if (kind === "file") await getPlatform().fs.createFile(path);
  else await getPlatform().fs.createDir(path);
  set({ explorerEdit: null });
  await loadDir(dirname(path));
  // Reveal: expand every folder on the way.
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) await toggleDir(parts.slice(0, i).join("/"), true);
  if (kind === "dir") await toggleDir(path, true);
  set({ selection: path });
  log("Explorer", `Created ${kind === "file" ? "file" : "folder"} ${path}`);
  return path;
}

export async function renameEntry(from: string, newName: string) {
  set({ explorerEdit: null });
  await moveEntry(from, join(dirname(from), newName.trim()));
}

/** Renames or moves a file/folder and keeps editors, dirty flags and the tree in step. */
function renamedId(id: string | null, from: string, to: string) {
  if (!id) return id;
  const m = /^(markdown|image):(.*)$/.exec(id);
  if (m && isWithin(m[2], from)) return `${m[1]}:${rebase(m[2], from, to)}`;
  return isWithin(id, from) ? rebase(id, from, to) : id;
}

export async function moveEntry(from: string, to: string) {
  if (to === from) return;
  if (isWithin(to, from)) throw new Error(`Cannot move '${from}' into itself.`);
  await getPlatform().fs.rename(from, to);
  const s = get();
  const groups = s.groups.map((g) => ({
    ...g,
    editors: g.editors.map((e): EditorInput => {
      if (e.kind === "file" && isWithin(e.path, from)) return { ...e, path: rebase(e.path, from, to), id: rebase(e.path, from, to) };
      if ((e.kind === "markdown" || e.kind === "image") && isWithin(e.path, from)) return { ...e, path: rebase(e.path, from, to), id: `${e.kind}:${rebase(e.path, from, to)}` };
      return e;
    }),
    activeId: renamedId(g.activeId, from, to),
  }));
  const dirty: Record<string, true> = {};
  for (const p of Object.keys(s.dirty)) dirty[rebase(p, from, to)] = true;
  const expanded: Record<string, true> = {};
  for (const p of Object.keys(s.expanded)) expanded[rebase(p, from, to)] = true;
  const dirs = { ...s.dirs };
  for (const d of Object.keys(dirs)) if (isWithin(d, from)) delete dirs[d];
  set({ groups, dirty, expanded, dirs, selection: to });
  renameListeners.forEach((l) => l(from, to));
  await loadDir(dirname(from));
  if (dirname(to) !== dirname(from)) await loadDir(dirname(to));
  for (const d of Object.keys(expanded)) if (isWithin(d, to)) await loadDir(d);
  log("Explorer", `Moved ${from} → ${to}`);
}

/** Run before an explorer delete (Local History keeps a copy of the files). Never blocks the delete. */
export const beforeDeleteHooks: ((path: string) => Promise<void>)[] = [];

/** "Delete permanently?" with Cancel focused: Enter can't confirm it by accident. */
function confirmPermanentDelete(message: string, detail: string) {
  return showDialog({
    message,
    detail,
    severity: "warning",
    buttons: [
      { id: "delete", label: "Delete Permanently", primary: true, destructive: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
}

/**
 * Explorer Delete, as in VS Code: moves the file or folder to the OS Trash
 * (Recycle Bin), so it can be restored. Where there is no Trash, or moving
 * fails, it asks again before deleting for good.
 */
export async function deleteEntry(path: string) {
  return deleteEntries([path]);
}

/** A repository's .git folder: the Explorer never deletes it (its history would be lost). */
export function isProtectedEntry(path: string) {
  return basename(path) === ".git";
}

/** Explorer Delete of several files and folders: one question, then each goes to the Trash. */
export async function deleteEntries(paths: string[]) {
  const fs = getPlatform().fs;
  // A folder's contents go with it: drop paths inside another selected folder.
  let list = [...new Set(paths)].filter((p) => p && !paths.some((q) => q !== p && isWithin(p, q)));
  if (list.some(isProtectedEntry)) {
    notify("warning", "TMCode doesn't delete the .git folder: it holds this project's history. Use Source Control instead.");
    list = list.filter((p) => !isProtectedEntry(p));
  }
  if (!list.length) return false;
  const isDirPath = (p: string) => Object.values(get().dirs).some((l) => l.some((e) => e.path === p && e.kind === "dir"));
  const name = basename(list[0]);
  const many = list.length > 1;
  const names = list.slice(0, 10).map(basename).join("\n") + (list.length > 10 ? `\n…and ${list.length - 10} more` : "");
  if (fs.trash) {
    const choice = await showDialog({
      message: many ? `Are you sure you want to delete the following ${list.length} files or folders?` : `Are you sure you want to delete '${name}'?`,
      detail: many ? `${names}\n\nYou can restore them from the Trash.` : `You can restore this ${isDirPath(list[0]) ? "folder" : "file"} from the Trash.`,
      severity: "warning",
      buttons: [
        { id: "trash", label: "Move to Trash", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice !== "trash") return false;
  } else {
    const choice = await confirmPermanentDelete(
      many ? `Are you sure you want to permanently delete the following ${list.length} files or folders?` : `Are you sure you want to permanently delete '${name}'?`,
      many ? `${names}\n\nThis cannot be undone.` : "This cannot be undone.",
    );
    if (choice !== "delete") return false;
  }
  let any = false;
  for (const path of list) if (await deleteOne(path)) any = true;
  return any;
}

async function deleteOne(path: string) {
  const fs = getPlatform().fs;
  const name = basename(path);
  for (const hook of beforeDeleteHooks) await hook(path).catch(() => {});
  let trashed = false;
  if (fs.trash) {
    try {
      await fs.trash(path);
      trashed = true;
    } catch (e) {
      const choice = await confirmPermanentDelete(
        `Could not move '${name}' to the Trash. Do you want to permanently delete it instead?`,
        `${String((e as Error)?.message ?? e)}\n\nThis cannot be undone.`,
      );
      if (choice !== "delete") return false;
    }
  }
  if (!trashed) await fs.remove(path);
  const s = get();
  const groups = s.groups.map((g) => {
    const editors = g.editors.filter((e) => !((e.kind === "file" || e.kind === "markdown" || e.kind === "image") && isWithin(e.path, path)));
    const activeId = editors.some((e) => e.id === g.activeId) ? g.activeId : (editors[editors.length - 1]?.id ?? null);
    return { ...g, editors, activeId };
  });
  const dirty = { ...s.dirty };
  for (const p of Object.keys(dirty)) if (isWithin(p, path)) delete dirty[p];
  const dirs = { ...s.dirs };
  for (const d of Object.keys(dirs)) if (isWithin(d, path) && d !== "") delete dirs[d];
  set({ groups, dirty, dirs, selection: null });
  deleteListeners.forEach((l) => l(path));
  await loadDir(dirname(path));
  log("Explorer", trashed ? `Moved ${path} to the Trash` : `Deleted ${path}`);
  return true;
}

type RenameListener = (from: string, to: string) => void;
type DeleteListener = (path: string) => void;
const renameListeners = new Set<RenameListener>();
const deleteListeners = new Set<DeleteListener>();
export function onEntryRenamed(l: RenameListener) {
  renameListeners.add(l);
  return () => renameListeners.delete(l);
}
export function onEntryDeleted(l: DeleteListener) {
  deleteListeners.add(l);
  return () => deleteListeners.delete(l);
}

// ───────────────────────────── editors ─────────────────────────────

function updateGroup(id: number, fn: (g: EditorGroup) => EditorGroup) {
  set({ groups: get().groups.map((g) => (g.id === id ? fn(g) : g)) });
}

export function activeEditor(state: WorkbenchState = get()): EditorInput | null {
  const g = state.groups.find((x) => x.id === state.activeGroup);
  return g?.editors.find((e) => e.id === g.activeId) ?? null;
}

export function activeFilePath(state: WorkbenchState = get()): string | null {
  const e = activeEditor(state);
  return e?.kind === "file" ? e.path : null;
}

/**
 * Opens a file. A single click opens a *preview* editor (italic tab, replaced
 * by the next preview); double-click, editing or `pinned` keeps it open.
 */
export function openFile(path: string, opts: { pinned?: boolean; group?: number } = {}) {
  const groupId = opts.group ?? get().activeGroup;
  updateGroup(groupId, (g) => {
    const existing = g.editors.find((e) => e.kind === "file" && e.path === path);
    if (existing) {
      const editors = opts.pinned ? g.editors.map((e) => (e === existing ? { ...e, preview: false } : e)) : g.editors;
      return { ...g, editors: editors as EditorInput[], activeId: existing.id };
    }
    const input: EditorInput = { kind: "file", id: path, path, preview: !opts.pinned };
    const previewIdx = g.editors.findIndex((e) => e.preview);
    const editors = [...g.editors];
    if (previewIdx >= 0 && !get().dirty[(editors[previewIdx] as { path?: string }).path ?? ""]) editors[previewIdx] = input;
    else {
      const activeIdx = editors.findIndex((e) => e.id === g.activeId);
      editors.splice(activeIdx + 1, 0, input);
    }
    return { ...g, editors, activeId: input.id };
  });
  set({ activeGroup: groupId, selection: path });
}

export function pinEditor(path: string) {
  const s = get();
  set({
    groups: s.groups.map((g) => ({
      ...g,
      editors: g.editors.map((e) => (e.kind === "file" && e.path === path && e.preview ? { ...e, preview: false } : e)),
    })),
  });
}

/** Opens (or focuses) a non-file editor such as a preview or a test diff. */
export function openEditorInput(input: Extract<EditorInput, { kind: "preview" | "testDiff" | "browser" | "markdown" | "image" | "extension" | "historyDiff" | "webview" | "assignment" | "grading" | "sqlResults" | "logic" | "api" }>, opts: { group?: number; toSide?: boolean } = {}) {
  let groupId = opts.group ?? get().activeGroup;
  if (opts.toSide) {
    const s = get();
    const idx = s.groups.findIndex((g) => g.id === s.activeGroup);
    const right = s.groups[idx + 1];
    if (right) groupId = right.id;
    else {
      const id = groupSeq++;
      const groups = [...s.groups];
      groups.splice(idx + 1, 0, { id, editors: [], activeId: null });
      set({ groups });
      groupId = id;
    }
  }
  updateGroup(groupId, (g) => {
    if (g.editors.some((e) => e.id === input.id)) {
      return { ...g, editors: g.editors.map((e) => (e.id === input.id ? input : e)), activeId: input.id };
    }
    const editors = [...g.editors];
    const activeIdx = editors.findIndex((e) => e.id === g.activeId);
    editors.splice(activeIdx + 1, 0, input);
    return { ...g, editors, activeId: input.id };
  });
  set({ activeGroup: groupId });
}

export function setRunState(run: Partial<RunState>) {
  set({ run: { ...get().run, ...run } });
}

export function setTests(tests: Partial<WorkbenchState["tests"]>) {
  set({ tests: { ...get().tests, ...tests } });
}

export function updateTest(id: string, patch: Partial<TestItem>) {
  const t = get().tests;
  set({ tests: { ...t, items: t.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) } });
}

export function openSpecialEditor(kind: "settings" | "welcome" | "shortcuts") {
  const groupId = get().activeGroup;
  updateGroup(groupId, (g) => {
    if (g.editors.some((e) => e.id === kind)) return { ...g, activeId: kind };
    const editors = [...g.editors];
    const activeIdx = editors.findIndex((e) => e.id === g.activeId);
    editors.splice(activeIdx + 1, 0, { kind, id: kind, preview: false } as EditorInput);
    return { ...g, editors, activeId: kind };
  });
}

export function activateEditor(groupId: number, id: string) {
  updateGroup(groupId, (g) => ({ ...g, activeId: id }));
  const e = get().groups.find((g) => g.id === groupId)?.editors.find((x) => x.id === id);
  set({ activeGroup: groupId, selection: e?.kind === "file" ? e.path : get().selection });
}

export function focusGroup(groupId: number) {
  if (get().activeGroup !== groupId) set({ activeGroup: groupId });
}

export async function confirmCloseDirty(paths: string[]): Promise<"save" | "discard" | "cancel"> {
  const dirtyPaths = paths.filter((p) => get().dirty[p]);
  if (!dirtyPaths.length) return "discard";
  const choice = await showDialog({
    message:
      dirtyPaths.length === 1
        ? `Do you want to save the changes you made to ${basename(dirtyPaths[0])}?`
        : `Do you want to save the changes to the following ${dirtyPaths.length} files?`,
    detail: dirtyPaths.length > 1 ? `${dirtyPaths.map(basename).join("\n")}\n\nYour changes will be lost if you don't save them.` : "Your changes will be lost if you don't save them.",
    severity: "warning",
    buttons: [
      { id: "save", label: dirtyPaths.length > 1 ? "Save All" : "Save", primary: true },
      { id: "discard", label: "Don't Save" },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice === "save") {
    for (const p of dirtyPaths) await saveHandlers.save(p);
  }
  return choice as "save" | "discard" | "cancel";
}

/** Registered by the documents module (Monaco models live there). */
export const saveHandlers: {
  save: (path: string) => Promise<void>;
  /** Closing without saving: drops the document. */
  revert: (path: string) => void;
  /** "Don't Save" while the editor stays open: reloads the file from disk. */
  discard: (path: string) => Promise<void>;
} = {
  save: async () => {},
  revert: () => {},
  discard: async () => {},
};

/** The document an editor edits: a file, or the right side of a working-tree git diff. */
function documentPath(e: EditorInput): string | null {
  if (e.kind === "file") return e.path;
  return e.kind === "gitDiff" && e.mode === "working" && !e.deleted ? e.path : null;
}

/** Still open in an editor that isn't closing (another group, or a diff/file tab of the same file). */
function openElsewhere(path: string, exceptGroup: number, closingIds: string[] = []) {
  return get().groups.some((g) => g.editors.some((e) => documentPath(e) === path && (g.id !== exceptGroup || !closingIds.includes(e.id))));
}

export async function closeEditors(groupId: number, ids: string[]) {
  const g = get().groups.find((x) => x.id === groupId);
  if (!g) return;
  const closing = g.editors.filter((e) => ids.includes(e.id));
  const closingPaths = [...new Set(closing.flatMap((e) => documentPath(e) ?? []))].filter((p) => !openElsewhere(p, groupId, ids));
  const choice = await confirmCloseDirty(closingPaths);
  if (choice === "cancel") return;
  if (choice === "discard") for (const p of closingPaths) if (get().dirty[p]) saveHandlers.revert(p);

  updateGroup(groupId, (grp) => {
    const idx = grp.editors.findIndex((e) => e.id === grp.activeId);
    const editors = grp.editors.filter((e) => !ids.includes(e.id));
    let activeId = grp.activeId;
    if (!activeId || ids.includes(activeId)) {
      // VS Code activates the editor to the right, else the one to the left.
      const fallback = grp.editors.slice(idx + 1).find((e) => !ids.includes(e.id)) ?? [...grp.editors.slice(0, idx)].reverse().find((e) => !ids.includes(e.id));
      activeId = fallback?.id ?? null;
    }
    return { ...grp, editors, activeId };
  });
  // An empty split closes; the last group always stays.
  const s = get();
  const target = s.groups.find((x) => x.id === groupId);
  if (target && !target.editors.length && s.groups.length > 1) {
    const groups = s.groups.filter((x) => x.id !== groupId);
    set({ groups, activeGroup: groups[Math.max(0, s.groups.indexOf(target) - 1)].id });
  }
  closedListeners.forEach((l) => l(closingPaths));
}

const closedListeners = new Set<(paths: string[]) => void>();
export function onEditorsClosed(l: (paths: string[]) => void) {
  closedListeners.add(l);
  return () => closedListeners.delete(l);
}

export async function closeActiveEditor() {
  const s = get();
  const g = s.groups.find((x) => x.id === s.activeGroup);
  if (g?.activeId) await closeEditors(g.id, [g.activeId]);
}

export async function closeAllEditors() {
  for (const g of [...get().groups]) await closeEditors(g.id, g.editors.map((e) => e.id));
}

export function splitEditor(direction: "right" = "right") {
  void direction;
  const s = get();
  if (s.groups.length >= 3) {
    notify("info", "TMCode supports up to three side-by-side editor groups.");
    return;
  }
  const current = activeEditor(s);
  const id = groupSeq++;
  const group: EditorGroup = { id, editors: current ? [{ ...current, preview: false } as EditorInput] : [], activeId: current?.id ?? null };
  const idx = s.groups.findIndex((g) => g.id === s.activeGroup);
  const groups = [...s.groups];
  groups.splice(idx + 1, 0, group);
  set({ groups, activeGroup: id });
}

export function moveEditor(fromGroup: number, id: string, toGroup: number, index: number) {
  const s = get();
  const from = s.groups.find((g) => g.id === fromGroup);
  const input = from?.editors.find((e) => e.id === id);
  if (!from || !input) return;
  if (fromGroup === toGroup) {
    updateGroup(fromGroup, (g) => {
      const editors = g.editors.filter((e) => e.id !== id);
      const at = Math.min(index > g.editors.indexOf(input) ? index - 1 : index, editors.length);
      editors.splice(at, 0, input);
      return { ...g, editors, activeId: id };
    });
    return;
  }
  updateGroup(toGroup, (g) => {
    const editors = g.editors.filter((e) => e.id !== id);
    editors.splice(Math.min(index, editors.length), 0, { ...input, preview: false } as EditorInput);
    return { ...g, editors, activeId: id };
  });
  set({ activeGroup: toGroup });
  void closeEditors(fromGroup, [id]);
}

export function setDirty(path: string, dirty: boolean) {
  const cur = get().dirty;
  if (!!cur[path] === dirty) return;
  const next = { ...cur };
  if (dirty) next[path] = true;
  else delete next[path];
  set({ dirty: next });
  if (dirty) pinEditor(path);
}

// ───────────────────────────── layout ─────────────────────────────

export function toggleSidebar(force?: boolean) {
  set({ sidebarVisible: force ?? !get().sidebarVisible });
  persist();
}

export function showView(view: ViewId) {
  const s = get();
  // Clicking the active view's icon hides the side bar, as in VS Code.
  if (s.sidebarVisible && s.activeView === view) set({ sidebarVisible: false });
  else set({ activeView: view, sidebarVisible: true });
  persist();
}

export function revealView(view: ViewId) {
  set({ activeView: view, sidebarVisible: true });
  persist();
}

export function togglePanel(force?: boolean) {
  const visible = force ?? !get().panelVisible;
  set({ panelVisible: visible, panelMaximized: visible ? get().panelMaximized : false });
  persist();
}

export function showPanel(panel: PanelId) {
  set({ activePanel: panel, panelVisible: true });
  persist();
}

export function togglePanelMaximized() {
  set({ panelMaximized: !get().panelMaximized, panelVisible: true });
}

// ───────────────────────────── settings ─────────────────────────────

export function updateSetting<K extends SettingKey>(key: K, value: Settings[K]) {
  if (get().policy.locked_settings.includes(key)) {
    notify("warning", "This setting is locked by your teacher for this session.");
    return;
  }
  set({ settings: { ...get().settings, [key]: value } });
  persist();
}

export function setPreviewTheme(theme: Settings["workbench.colorTheme"] | null) {
  set({ previewTheme: theme });
}

export function setPreviewIconTheme(theme: string | null) {
  set({ previewIconTheme: theme });
}

export function setPolicy(policy: Policy) {
  set({ policy });
}

// ───────────────────────────── status / panels ─────────────────────────────

export function setCursor(cursor: WorkbenchState["cursor"]) {
  const c = get().cursor;
  if (c.line !== cursor.line || c.column !== cursor.column || c.selected !== cursor.selected) set({ cursor });
}

export function setEditorInfo(info: { language: string | null; eol: "LF" | "CRLF" }) {
  set({ activeLanguage: info.language, eol: info.eol });
}

export function setProblems(problems: Problem[]) {
  set({ problems });
}

const MAX_OUTPUT = 2000;
export function log(channel: string, text: string, level: OutputLine["level"] = "info") {
  const output = [...get().output, { t: Date.now(), channel, text, level }];
  set({ output: output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output });
}

export function clearOutput() {
  set({ output: [] });
}

const MAX_NOTIFICATIONS = 5;
/** Notifications the student still has to act on: buttons, or a running operation's progress / Cancel. */
const needsAction = (n: Notification) => !!n.actions?.length || n.progress !== undefined || !!n.cancel;

/**
 * Keeps at most five toasts without ever pushing out one with buttons ("changed
 * on disk… Discard my changes") or a running operation: the oldest plain info
 * goes first, then the oldest plain warning or error.
 */
function capNotifications(list: Notification[]): Notification[] {
  const out = [...list];
  while (out.length > MAX_NOTIFICATIONS) {
    let i = out.findIndex((n) => n.severity === "info" && !needsAction(n));
    if (i < 0) i = out.findIndex((n) => !needsAction(n));
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out;
}

export function notify(severity: Notification["severity"], message: string, actions?: Notification["actions"]) {
  const id = ++notificationSeq;
  set({ notifications: capNotifications([...get().notifications, { id, severity, message, actions }]) });
  log("Notifications", message, severity === "error" ? "error" : severity === "warning" ? "warn" : "info");
  if (severity === "info" && !actions?.length) setTimeout(() => dismissNotification(id), 6000);
  return id;
}

/**
 * A progress notification (clone, pull, push…) with an optional Cancel, like
 * VS Code's `withProgress({ location: Notification, cancellable })`.
 */
export function notifyProgress(message: string, opts: { cancel?: () => void } = {}) {
  const id = ++notificationSeq;
  set({ notifications: capNotifications([...get().notifications, { id, severity: "info" as const, message, progress: null, cancel: opts.cancel }]) });
  return {
    id,
    update(patch: { message?: string; progress?: number | null }) {
      set({ notifications: get().notifications.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
    },
    close: () => dismissNotification(id),
  };
}

export function dismissNotification(id: number) {
  set({ notifications: get().notifications.filter((n) => n.id !== id) });
}

export function showDialog(req: Omit<DialogRequest, "resolve">): Promise<string> {
  return new Promise((resolve) => {
    set({
      dialog: {
        ...req,
        resolve: (id) => {
          set({ dialog: null });
          resolve(id);
        },
      },
    });
  });
}

export function openQuickInput(mode: QuickInputMode, initial?: string) {
  set({ quickInput: { mode, initial }, contextMenu: null });
}

export function closeQuickInput() {
  set({ quickInput: null, previewTheme: null, previewIconTheme: null });
}

export function openContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  set({ contextMenu: { x, y, items } });
}

export function closeContextMenu() {
  if (get().contextMenu) set({ contextMenu: null });
}

export const workbench = { get, set };
