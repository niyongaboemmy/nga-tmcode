import { codeEditorFor, onCodeEditor } from "../monaco/editors";
import { pathOfUri } from "../monaco/documents";
import { UNTITLED_SCHEME, isUntitled } from "../util/untitled";
import {
  activeEditor,
  focusGroup,
  onEntryDeleted,
  openFile,
  openQuickInput,
  openSpecialEditor,
  splitEditor,
  useWorkbench,
  workbench,
  type EditorInput,
  type WorkbenchState,
} from "../state/store";
import { NavigationStack, mruOrder, touchMru, type Location } from "./history";
import { loadRecentFiles, saveRecentFiles } from "../widgets/quickOpenLogic";
import { registerCommand } from "./registry";

/**
 * V8 editor history: Ctrl+Tab (most recently used editors), Reopen Closed
 * Editor, Go Back / Go Forward, Focus Editor Group 1-3, and the recently
 * opened files Quick Open lists first.
 */

const mru = new Map<number, string[]>();
type Closed = { input: EditorInput; group: number };
let closed: Closed[] = [];
let recent: string[] = [];
let recentRoot: string | null = null;
export const navigation = new NavigationStack();
let navigating = 0;

export function recentFiles() {
  return recent;
}

/** Clear Recently Opened: the open folder's recent files too. */
export function clearRecentFiles() {
  recent = [];
  if (recentRoot) saveRecentFiles(recentRoot, []);
}

/** A group's open editors, most recently used first. */
export function editorsByMru(groupId: number): EditorInput[] {
  const g = useWorkbench.getState().groups.find((x) => x.id === groupId);
  if (!g) return [];
  const order = mruOrder(mru.get(groupId) ?? [], g.editors.map((e) => e.id));
  return order.map((id) => g.editors.find((e) => e.id === id)!).filter(Boolean);
}

const reopenable = (e: EditorInput) => (e.kind === "file" && !isUntitled(e.path)) || e.kind === "settings" || e.kind === "shortcuts" || e.kind === "welcome";

function onState(s: WorkbenchState, prev: WorkbenchState) {
  const root = s.workspace?.root ?? null;
  if (root !== recentRoot) {
    recentRoot = root;
    recent = root ? loadRecentFiles(root) : [];
    closed = [];
    navigation.clear();
  }
  if (s.groups === prev.groups && s.activeGroup === prev.activeGroup) return;
  // MRU per group, and recently opened files.
  for (const g of s.groups) {
    if (!g.activeId) continue;
    const list = mru.get(g.id) ?? [];
    if (list[0] !== g.activeId) mru.set(g.id, touchMru(list, g.activeId));
  }
  for (const id of [...mru.keys()]) if (!s.groups.some((g) => g.id === id)) mru.delete(id);
  const active = activeEditor(s);
  if (active?.kind === "file" && !isUntitled(active.path) && root && recent[0] !== active.path) {
    recent = touchMru(recent, active.path);
    saveRecentFiles(root, recent);
  }
  // Closed editors: gone from every group (a move between groups is not a close).
  const openIds = new Set(s.groups.flatMap((g) => g.editors.map((e) => e.id)));
  for (const g of prev.groups) {
    for (const e of g.editors) {
      if (openIds.has(e.id) || !reopenable(e)) continue;
      closed = [{ input: e, group: g.id }, ...closed.filter((c) => c.input.id !== e.id)].slice(0, 20);
    }
  }
  if (closed.length) closed = closed.filter((c) => !openIds.has(c.input.id));
}

export function reopenClosedEditor() {
  const next = closed.shift();
  if (!next) return;
  const groups = useWorkbench.getState().groups;
  const group = groups.some((g) => g.id === next.group) ? next.group : workbench.get().activeGroup;
  if (next.input.kind === "file") openFile(next.input.path, { pinned: true, group });
  else if (next.input.kind === "settings" || next.input.kind === "shortcuts" || next.input.kind === "welcome") {
    focusGroup(group);
    openSpecialEditor(next.input.kind);
  }
}

// ── Back / Forward ──
function groupOfEditor(ed: unknown): number | undefined {
  return useWorkbench.getState().groups.find((g) => codeEditorFor(g.id) === ed)?.id;
}

function recordFrom(ed: import("../monaco/setup").monaco.editor.ICodeEditor) {
  if (navigating) return;
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos) return;
  if (model.uri.scheme !== "tmcode" && model.uri.scheme !== UNTITLED_SCHEME) return;
  const group = groupOfEditor(ed);
  if (group === undefined) return;
  navigation.record({ path: pathOfUri(model.uri), line: pos.lineNumber, column: pos.column, group });
}

function goTo(loc: Location) {
  navigating++;
  const s = useWorkbench.getState();
  const group = loc.group !== undefined && s.groups.some((g) => g.id === loc.group) ? loc.group : s.activeGroup;
  openFile(loc.path, { pinned: true, group });
  const done = () => setTimeout(() => navigating--, 50);
  const apply = (n = 0) => {
    const ed = codeEditorFor(group);
    const model = ed?.getModel();
    if (ed && model && pathOfUri(model.uri) === loc.path) {
      ed.setPosition({ lineNumber: loc.line, column: loc.column });
      ed.revealLineInCenterIfOutsideViewport(loc.line);
      ed.focus();
      done();
    } else if (n < 40) setTimeout(() => apply(n + 1), 25);
    else done();
  };
  apply();
}

export function navigateBack() {
  const loc = navigation.back();
  if (loc) goTo(loc);
}
export function navigateForward() {
  const loc = navigation.forward();
  if (loc) goTo(loc);
}

/** ⌘1/⌘2/⌘3: focus that group's editor; one past the last group splits, as in VS Code. */
export function focusEditorGroup(n: number) {
  const s = useWorkbench.getState();
  const g = s.groups[n - 1];
  if (!g) {
    if (n === s.groups.length + 1 && n <= 3 && activeEditor(s)) splitEditor();
    return;
  }
  focusGroup(g.id);
  const ed = codeEditorFor(g.id);
  if (ed && activeEditor(useWorkbench.getState())?.kind === "file") ed.focus();
  else (document.querySelector(`[data-group-id="${g.id}"]`) as HTMLElement | null)?.focus();
}

let wired = false;
export function registerNavigationCommands() {
  if (wired) return;
  wired = true;
  let prev = useWorkbench.getState();
  onState(prev, { ...prev, groups: [] });
  useWorkbench.subscribe((s) => {
    const p = prev;
    prev = s;
    onState(s, p);
  });
  onCodeEditor((ed) => {
    ed.onDidChangeCursorPosition(() => recordFrom(ed));
    // A new model restores its own view state a moment later.
    ed.onDidChangeModel(() => setTimeout(() => recordFrom(ed), 0));
  });
  onEntryDeleted((path) => navigation.clear(path));

  const hasEditors = () => (useWorkbench.getState().groups.find((g) => g.id === workbench.get().activeGroup)?.editors.length ?? 0) > 1;
  registerCommand({
    id: "workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup",
    title: "Quick Open Previous Recently Used Editor in Group",
    category: "View",
    keybinding: "ctrl+tab",
    enabled: hasEditors,
    run: () => openQuickInput("editors"),
  });
  registerCommand({
    id: "workbench.action.quickOpenLeastRecentlyUsedEditorInGroup",
    title: "Quick Open Least Recently Used Editor in Group",
    category: "View",
    keybinding: "ctrl+shift+tab",
    enabled: hasEditors,
    run: () => openQuickInput("editors", "last"),
  });
  registerCommand({
    id: "workbench.action.showAllEditorsByMostRecentlyUsed",
    title: "Show All Editors By Most Recently Used",
    category: "View",
    run: () => openQuickInput("editors", "list"),
  });
  registerCommand({
    id: "workbench.action.reopenClosedEditor",
    title: "Reopen Closed Editor",
    category: "View",
    keybinding: "mod+shift+t",
    enabled: () => closed.length > 0,
    run: reopenClosedEditor,
  });
  registerCommand({
    id: "workbench.action.navigateBack",
    title: "Go Back",
    category: "Go",
    mac: "ctrl+-",
    win: "alt+left",
    enabled: () => navigation.canBack(),
    run: navigateBack,
  });
  registerCommand({
    id: "workbench.action.navigateForward",
    title: "Go Forward",
    category: "Go",
    mac: "ctrl+shift+-",
    win: "alt+right",
    enabled: () => navigation.canForward(),
    run: navigateForward,
  });
  const ordinal = ["First", "Second", "Third"];
  for (const n of [1, 2, 3]) {
    registerCommand({
      id: `workbench.action.focus${ordinal[n - 1]}EditorGroup`,
      title: `Focus ${ordinal[n - 1]} Editor Group`,
      category: "View",
      keybinding: `mod+${n}`,
      run: () => focusEditorGroup(n),
    });
  }
}
