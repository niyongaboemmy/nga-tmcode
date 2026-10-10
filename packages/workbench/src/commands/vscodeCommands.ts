import { registerCommand, executeCommand, getCommand, isEnabled } from "./registry";
import { targetEditor } from "./editorCommands";
import { clearRecentFiles, recentFiles } from "./navigation";
import { adjacentEditor, changeStarts, editorIdsToTheRight, moveWithinGroup, nextChangeLine, otherEditorIds, savedEditorIds, siblingGroup } from "./editorOrder";
import { recentItems } from "./recentLogic";
import { codeEditorFor } from "../monaco/editors";
import { inExam } from "../exam/state";
import { isDebugging } from "../debug/debugService";
import { beforeReload } from "../state/quit";
import { useMaximizedGroup } from "../state/editorMaximize";
import { clearAllNotifications, showNotificationCenter, toggleDoNotDisturb, useNotificationCenter } from "../state/notificationCenter";
import { groupOrder, neighbour, reconcile } from "../state/layout";
import { activeTerminal } from "../terminal/active";
import { runInTerminal } from "../tasks/service";
import { defaultBuildTask } from "../tasks/buildTask";
import { configureUserSnippets, insertSnippet, userSnippetsAllowed } from "../snippets/userSnippets";
import { listFiles } from "../parts/search/search";
import { showQuickPick } from "../widgets/QuickPick";
import { basename, dirname } from "../util/paths";
import { terminalAllowed as allowsTerminal } from "@tmcode/protocol";
import {
  activateEditor,
  activeEditor,
  activeFilePath,
  addGroup,
  clearRecentFolders,
  closeEditors,
  flushLayoutSave,
  getPlatform,
  moveEditor,
  moveEditorToNewGroup,
  notify,
  openEditorInput,
  openFile,
  openRecent,
  pinEditor,
  revealView,
  select,
  showDialog,
  showPanel,
  toggleDir,
  updateSetting,
  useWorkbench,
  type EditorGroup,
} from "../state/store";

/**
 * VS Code's default commands TMCode was missing (window, editors and
 * groups, layout toggles, breadcrumbs, tasks and terminal, notifications,
 * auto save, quick-diff navigation, snippets), with VS Code's ids, titles
 * and keys. Kept out of commands/builtin.ts.
 */

const get = useWorkbench.getState;
const hasWorkspace = () => !!get().workspace;
const hasActiveFile = () => !!activeFilePath();
const terminalAllowed = () => !!getPlatform().terminal && allowsTerminal(get().policy);
const activeGroup = (): EditorGroup | undefined => get().groups.find((g) => g.id === get().activeGroup);
const groupsInOrder = () => {
  const s = get();
  const order = groupOrder(reconcile(s.editorLayout, s.groups.map((g) => g.id)));
  return order.map((id) => s.groups.find((g) => g.id === id)!).filter(Boolean);
};
const withDirty = (g: EditorGroup) => g.editors.map((e) => ({ ...e, dirty: (e.kind === "file" || (e.kind === "gitDiff" && e.mode === "working")) && !!get().dirty[e.path] }));
const terminalFocused = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");

// ───────────── window ─────────────

/** Developer: Reload Window — after the quit checks, with the layout saved and the host's processes stopped. */
export async function reloadWindow() {
  if (!(await beforeReload().catch(() => false))) return;
  await flushLayoutSave();
  await getPlatform()
    .shell?.beforeReload?.()
    .catch(() => {});
  location.reload();
}

export async function toggleFullScreen() {
  const shell = getPlatform().shell;
  if (shell?.toggleFullScreen) return shell.toggleFullScreen();
  // Browser build: the page's own full screen.
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  else await document.documentElement.requestFullscreen?.().catch(() => {});
}

/** File › Open Recent: recent folders, then this folder's recent files. */
export async function pickRecent() {
  const s = get();
  const items = recentItems(s.recent, s.workspace ? recentFiles() : [], s.workspace?.root ?? null);
  if (!items.length) {
    notify("info", "There are no recently opened folders or files yet.");
    return;
  }
  const pick = await showQuickPick({
    placeholder: "Select a folder or file to open",
    matchOnDescription: true,
    items: [
      ...items.map((it, i) => ({ id: String(i), label: it.label, description: it.description, icon: it.kind === "folder" ? "folder" : "file", separator: it.separator })),
      { id: "clear", label: "Clear Recently Opened...", icon: "clear-all", separator: "", pinLast: true },
    ],
  });
  if (!pick) return;
  if (pick.id === "clear") return void clearRecentlyOpened();
  const it = items[Number(pick.id)];
  if (it.kind === "folder") await openRecent(it.target);
  else openFile(it.target, { pinned: true });
}

export async function clearRecentlyOpened() {
  const choice = await showDialog({
    message: "Do you want to clear all recently opened files and folders?",
    detail: "This can't be undone.",
    severity: "warning",
    buttons: [
      { id: "clear", label: "Clear", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
    cancelId: "cancel",
  });
  if (choice !== "clear") return;
  clearRecentFolders();
  clearRecentFiles();
}

// ───────────── editors and groups ─────────────

/** Opens a file in the group to the right (a new one when there is none): Open to the Side. */
export function openFileToSide(path: string) {
  const s = get();
  const right = neighbour(reconcile(s.editorLayout, s.groups.map((g) => g.id)), s.activeGroup, "right");
  const target = right ?? addGroup(s.activeGroup, "right");
  if (target == null) return openFile(path, { pinned: true });
  openFile(path, { pinned: true, group: target });
}

export function openAdjacentEditor(step: 1 | -1) {
  const next = adjacentEditor(groupsInOrder(), get().activeGroup, step);
  if (!next) return;
  activateEditor(next.group, next.id);
  focusEditorOf(next.group);
}

function focusEditorOf(group: number) {
  requestAnimationFrame(() => {
    const e = activeEditor();
    if (e?.kind === "file") codeEditorFor(group)?.focus();
  });
}

function moveActiveInGroup(step: 1 | -1) {
  const g = activeGroup();
  if (!g?.activeId) return;
  if (!moveWithinGroup(g.editors, g.activeId, step)) return;
  const at = g.editors.findIndex((e) => e.id === g.activeId);
  // moveEditor() inserts before `index` (counted with the moved tab still in place).
  moveEditor(g.id, g.activeId, g.id, step > 0 ? at + 2 : at - 1);
}

function moveActiveToGroup(step: 1 | -1) {
  const g = activeGroup();
  if (!g?.activeId) return;
  const target = siblingGroup(groupsInOrder().map((x) => x.id), g.id, step);
  if (target != null) {
    const tg = get().groups.find((x) => x.id === target)!;
    moveEditor(g.id, g.activeId, target, tg.editors.length);
  } else if (step > 0 && g.editors.length > 1) {
    // No group to the right yet: VS Code makes one.
    moveEditorToNewGroup(g.id, g.activeId, g.id, "right");
  }
}

function closeInActiveGroup(pick: (g: EditorGroup) => string[]) {
  const g = activeGroup();
  if (!g) return;
  const ids = pick(g);
  if (ids.length) void closeEditors(g.id, ids);
}

export async function revealInExplorer(path: string) {
  revealView("explorer");
  const parts = path.split("/");
  for (let j = 1; j < parts.length; j++) await toggleDir(parts.slice(0, j).join("/"), true);
  select(path);
  requestAnimationFrame(() => (document.querySelector(`.tm-explorer [data-path="${CSS.escape(path)}"]`) as HTMLElement | null)?.scrollIntoView({ block: "nearest" }));
}

/** The OS path of a workspace file (Copy Path). */
export function absolutePath(path: string) {
  const root = get().workspace?.root ?? "";
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${sep === "\\" ? path.replace(/\//g, "\\") : path}`;
}

async function copyText(text: string) {
  const clip = getPlatform().clipboard;
  if (clip) await clip.writeText(text);
  else await navigator.clipboard?.writeText(text);
}

export function compareWithSaved(path = activeFilePath()) {
  if (!path) return;
  openEditorInput({ kind: "historyDiff", id: `saved:${path}`, path, entry: path, time: Date.now(), preview: false, source: "saved", label: "Saved" });
}

async function compareActiveFileWith() {
  const path = activeFilePath();
  if (!path) return;
  const files = (await listFiles(getPlatform().fs).catch(() => [] as string[])).filter((f) => f !== path);
  const pick = await showQuickPick({
    placeholder: `Select a file to compare with ${basename(path)}`,
    matchOnDescription: true,
    items: files.slice(0, 2000).map((f) => ({ id: f, label: basename(f), description: dirname(f) })),
  });
  if (!pick) return;
  openEditorInput({ kind: "historyDiff", id: `compare:${path}:${pick.id}`, path: pick.id, entry: path, time: Date.now(), preview: false, source: "file", label: basename(path) });
}

// ───────────── quick diff: next / previous change ─────────────

function goToChange(step: 1 | -1) {
  const ed = targetEditor() ?? codeEditorFor(get().activeGroup);
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  if (!ed || !model || !pos) return;
  const lines = model
    .getAllDecorations()
    .filter((d) => /tm-dirty-diff-/.test(d.options.linesDecorationsClassName ?? ""))
    .flatMap((d) => {
      const out: number[] = [];
      for (let l = d.range.startLineNumber; l <= d.range.endLineNumber; l++) out.push(l);
      return out;
    });
  const line = nextChangeLine(changeStarts(lines), pos.lineNumber, step);
  if (line == null) {
    notify("info", "There are no changes in this file.");
    return;
  }
  ed.setPosition({ lineNumber: line, column: 1 });
  ed.revealLineInCenter(line);
  ed.focus();
}

// ───────────── terminal ─────────────

function runSelectedText() {
  const ed = targetEditor() ?? codeEditorFor(get().activeGroup);
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel) return;
  // No selection: the current line, as VS Code does.
  const text = sel.isEmpty() ? model.getLineContent(sel.positionLineNumber) : model.getValueInRange(sel);
  if (!text.trim()) return;
  showPanel("terminal");
  setTimeout(() => window.dispatchEvent(new CustomEvent("tmcode:terminal-run", { detail: text.replace(/\r?\n/g, "\r") })), 0);
}

function focusTerminal() {
  showPanel("terminal");
  setTimeout(() => activeTerminal()?.focus(), 30);
}

// ───────────── tasks ─────────────

async function runBuildTask() {
  const fs = getPlatform().fs;
  const text = await fs.readFile(".vscode/tasks.json").catch(() => null);
  const task = text ? defaultBuildTask(text, getPlatform().os) : null;
  if (task) {
    const { ensureTrusted } = await import("../trust/trust");
    if (!(await ensureTrusted("Tasks"))) return;
    runInTerminal(task.command, { cwd: task.cwd, name: task.label });
    return;
  }
  // No build task: the Run hub's run target (VS Code would offer to configure one).
  const run = getCommand("tmcode.runProject");
  if (run && isEnabled(run)) executeCommand(run.id);
  else notify("info", "No build task to run. Add one with \"group\": \"build\" to .vscode/tasks.json.");
}

// ───────────── breadcrumbs ─────────────

/** Asks the active group's breadcrumbs to take focus (and open the last crumb's list). */
function focusBreadcrumbs(andSelect: boolean) {
  if (!get().settings["breadcrumbs.enabled"]) updateSetting("breadcrumbs.enabled", true);
  setTimeout(() => window.dispatchEvent(new CustomEvent("tmcode:breadcrumbs", { detail: { group: get().activeGroup, select: andSelect } })), 0);
}

let registered = false;
export function registerVsCodeCommands() {
  if (registered) return;
  registered = true;
  const platform = getPlatform();
  const os = platform.os;
  // A maximized group gives way when another group gets focus or it is the only one left.
  useWorkbench.subscribe((s) => {
    const m = useMaximizedGroup.getState().group;
    if (m != null && (s.activeGroup !== m || s.groups.length < 2)) useMaximizedGroup.setState({ group: null });
  });

  // ── window ──
  registerCommand({ id: "workbench.action.reloadWindow", title: "Reload Window", category: "Developer", keybinding: "mod+r", run: reloadWindow });
  registerCommand({
    id: "workbench.action.openRecent",
    title: "Open Recent...",
    category: "File",
    // VS Code's ⌃R (macOS). Elsewhere Ctrl+R reloads the window, so Open Recent moves to Ctrl+Alt+O.
    mac: "ctrl+r",
    win: "mod+alt+o",
    enabled: () => !inExam(),
    run: pickRecent,
  });
  registerCommand({ id: "workbench.action.clearRecentFiles", title: "Clear Recently Opened...", category: "File", enabled: () => !inExam(), run: clearRecentlyOpened });
  registerCommand({
    id: "workbench.action.toggleFullScreen",
    title: "Toggle Full Screen",
    category: "View",
    mac: "ctrl+mod+f",
    win: "f11",
    // F11 is Step Into while debugging (VS Code's `inDebugMode`).
    when: () => os === "mac" || !isDebugging(),
    run: toggleFullScreen,
  });
  registerCommand({
    id: "workbench.action.closeWindow",
    title: "Close Window",
    category: "Window",
    mac: "mod+shift+w",
    win: "alt+f4",
    enabled: () => !!platform.shell?.closeWindow,
    run: () => platform.shell?.closeWindow?.(),
  });
  // Only where the host can open developer tools (debug builds); never in an exam.
  if (platform.shell?.toggleDevTools) {
    registerCommand({
      id: "workbench.action.toggleDevTools",
      title: "Toggle Developer Tools",
      category: "Developer",
      mac: "mod+alt+i",
      win: "mod+shift+i",
      enabled: () => !inExam() && get().policy.mode === "practice",
      run: () => platform.shell?.toggleDevTools?.(),
    });
  }

  // ── editors and groups ──
  const hasEditor = () => !!activeGroup()?.activeId;
  const manyEditors = () => get().groups.reduce((n, g) => n + g.editors.length, 0) > 1;
  registerCommand({ id: "workbench.action.nextEditor", title: "Open Next Editor", category: "View", mac: "mod+alt+right", win: "mod+pagedown", enabled: manyEditors, run: () => openAdjacentEditor(1) });
  registerCommand({ id: "workbench.action.previousEditor", title: "Open Previous Editor", category: "View", mac: "mod+alt+left", win: "mod+pageup", enabled: manyEditors, run: () => openAdjacentEditor(-1) });
  registerCommand({
    id: "workbench.action.moveEditorLeftInGroup",
    title: "Move Editor Left",
    category: "View",
    mac: "mod+k mod+shift+left",
    win: "mod+shift+pageup",
    enabled: hasEditor,
    run: () => moveActiveInGroup(-1),
  });
  registerCommand({
    id: "workbench.action.moveEditorRightInGroup",
    title: "Move Editor Right",
    category: "View",
    mac: "mod+k mod+shift+right",
    win: "mod+shift+pagedown",
    enabled: hasEditor,
    run: () => moveActiveInGroup(1),
  });
  registerCommand({ id: "workbench.action.moveEditorToNextGroup", title: "Move Editor into Next Group", category: "View", mac: "ctrl+mod+right", win: "mod+alt+right", enabled: hasEditor, run: () => moveActiveToGroup(1) });
  registerCommand({ id: "workbench.action.moveEditorToPreviousGroup", title: "Move Editor into Previous Group", category: "View", mac: "ctrl+mod+left", win: "mod+alt+left", enabled: hasEditor, run: () => moveActiveToGroup(-1) });
  registerCommand({
    id: "workbench.action.closeOtherEditors",
    title: "Close Other Editors in Group",
    category: "View",
    mac: "mod+alt+t",
    enabled: hasEditor,
    run: () => closeInActiveGroup((g) => otherEditorIds(g.editors, g.activeId!)),
  });
  registerCommand({
    id: "workbench.action.closeEditorsToTheRight",
    title: "Close Editors to the Right in Group",
    category: "View",
    enabled: hasEditor,
    run: () => closeInActiveGroup((g) => editorIdsToTheRight(g.editors, g.activeId!)),
  });
  registerCommand({
    id: "workbench.action.closeUnmodifiedEditors",
    title: "Close Saved Editors in Group",
    category: "View",
    keybinding: "mod+k u",
    enabled: hasEditor,
    run: () => closeInActiveGroup((g) => savedEditorIds(withDirty(g))),
  });
  registerCommand({
    id: "workbench.action.closeEditorsInGroup",
    title: "Close All Editors in Group",
    category: "View",
    keybinding: "mod+k w",
    enabled: hasEditor,
    run: () => closeInActiveGroup((g) => g.editors.map((e) => e.id)),
  });
  registerCommand({
    id: "workbench.action.closeGroup",
    title: "Close Editor Group",
    category: "View",
    enabled: () => get().groups.length > 1 || hasEditor(),
    run: () => closeInActiveGroup((g) => g.editors.map((e) => e.id)),
  });
  registerCommand({
    id: "workbench.action.keepEditor",
    title: "Keep Editor",
    category: "View",
    keybinding: "mod+k enter",
    enabled: () => !!activeEditor()?.preview,
    run: () => {
      const e = activeEditor();
      if (e?.kind === "file") pinEditor(e.path);
    },
  });
  registerCommand({
    id: "workbench.action.toggleMaximizeEditorGroup",
    title: "Toggle Maximize Editor Group",
    category: "View",
    keybinding: "mod+k mod+m",
    enabled: () => get().groups.length > 1 || useMaximizedGroup.getState().group != null,
    run: () => {
      const cur = useMaximizedGroup.getState().group;
      useMaximizedGroup.setState({ group: cur != null ? null : get().activeGroup });
    },
  });
  registerCommand({
    id: "explorer.openToSide",
    title: "Open to the Side",
    category: "File",
    keybinding: "mod+enter",
    when: () => !!(document.activeElement as HTMLElement | null)?.closest?.(".tm-explorer"),
    enabled: () => {
      const sel = get().selection;
      return !!sel && !get().dirs[sel];
    },
    run: () => {
      const sel = get().selection;
      if (sel) openFileToSide(sel);
    },
  });
  registerCommand({ id: "workbench.files.action.compareWithSaved", title: "Compare Active File with Saved", category: "File", keybinding: "mod+k d", enabled: hasActiveFile, run: () => compareWithSaved() });
  registerCommand({ id: "workbench.files.action.compareFileWith", title: "Compare Active File With...", category: "File", enabled: () => hasActiveFile() && hasWorkspace(), run: compareActiveFileWith });
  registerCommand({
    id: "workbench.action.files.copyPathOfActiveFile",
    title: "Copy Path of Active File",
    category: "File",
    keybinding: "mod+k p",
    enabled: hasActiveFile,
    run: () => copyText(absolutePath(activeFilePath()!)),
  });
  registerCommand({
    id: "workbench.action.files.copyRelativePathOfActiveFile",
    title: "Copy Relative Path of Active File",
    category: "File",
    keybinding: "mod+k mod+shift+alt+c",
    enabled: hasActiveFile,
    run: () => copyText(activeFilePath()!),
  });
  registerCommand({
    id: "workbench.files.action.showActiveFileInExplorer",
    title: "Reveal Active File in Explorer View",
    category: "File",
    enabled: hasActiveFile,
    run: () => revealInExplorer(activeFilePath()!),
  });

  // ── layout toggles (View › Appearance), saved with the settings ──
  const toggle = (key: "workbench.activityBar.visible" | "workbench.statusBar.visible" | "breadcrumbs.enabled") => () => updateSetting(key, !get().settings[key]);
  registerCommand({ id: "workbench.action.toggleActivityBarVisibility", title: "Toggle Activity Bar Visibility", category: "View", run: toggle("workbench.activityBar.visible") });
  registerCommand({ id: "workbench.action.toggleStatusbarVisibility", title: "Toggle Status Bar Visibility", category: "View", run: toggle("workbench.statusBar.visible") });
  registerCommand({ id: "breadcrumbs.toggle", title: "Toggle Breadcrumbs", category: "View", run: toggle("breadcrumbs.enabled") });
  registerCommand({
    id: "workbench.action.toggleSidebarPosition",
    title: "Toggle Primary Side Bar Position",
    category: "View",
    run: () => updateSetting("workbench.sideBar.location", get().settings["workbench.sideBar.location"] === "right" ? "left" : "right"),
  });
  registerCommand({
    id: "editor.action.toggleRenderWhitespace",
    title: "Toggle Render Whitespace",
    category: "View",
    run: () => updateSetting("editor.renderWhitespace", get().settings["editor.renderWhitespace"] === "none" ? "all" : "none"),
  });
  registerCommand({
    id: "editor.action.toggleStickyScroll",
    title: "Toggle Editor Sticky Scroll",
    category: "View",
    run: () => updateSetting("editor.stickyScroll.enabled", !get().settings["editor.stickyScroll.enabled"]),
  });

  // ── breadcrumbs ──
  const breadcrumbsShown = () => hasActiveFile();
  registerCommand({ id: "breadcrumbs.focusAndSelect", title: "Focus and Select Breadcrumbs", category: "View", keybinding: "mod+shift+.", enabled: breadcrumbsShown, run: () => focusBreadcrumbs(true) });
  registerCommand({ id: "breadcrumbs.focus", title: "Focus Breadcrumbs", category: "View", keybinding: "mod+shift+;", enabled: breadcrumbsShown, run: () => focusBreadcrumbs(false) });

  // ── tasks and terminal ──
  registerCommand({ id: "workbench.action.tasks.build", title: "Run Build Task", category: "Tasks", keybinding: "mod+shift+b", enabled: () => hasWorkspace() && terminalAllowed(), run: runBuildTask });
  registerCommand({
    id: "workbench.action.terminal.clear",
    title: "Clear",
    category: "Terminal",
    mac: "mod+k",
    when: terminalFocused,
    enabled: () => terminalAllowed() && !!activeTerminal(),
    run: () => activeTerminal()?.clear(),
  });
  registerCommand({ id: "workbench.action.terminal.focus", title: "Focus Terminal", category: "Terminal", enabled: terminalAllowed, run: focusTerminal });
  registerCommand({ id: "workbench.action.terminal.runSelectedText", title: "Run Selected Text In Active Terminal", category: "Terminal", enabled: () => terminalAllowed() && hasActiveFile(), run: runSelectedText });

  // ── notifications ──
  registerCommand({ id: "notifications.showList", title: "Show Notifications", category: "Notifications", run: () => showNotificationCenter(true) });
  registerCommand({ id: "notifications.hideList", title: "Hide Notifications", category: "Notifications", hidden: true, enabled: () => useNotificationCenter.getState().open, run: () => showNotificationCenter(false) });
  registerCommand({ id: "notifications.clearAll", title: "Clear All Notifications", category: "Notifications", run: clearAllNotifications });
  registerCommand({ id: "notifications.toggleDoNotDisturbMode", title: "Toggle Do Not Disturb Mode", category: "Notifications", run: toggleDoNotDisturb });

  // ── file / editor ──
  registerCommand({
    id: "workbench.action.toggleAutoSave",
    title: "Toggle Auto Save",
    category: "File",
    run: () => updateSetting("files.autoSave", get().settings["files.autoSave"] === "off" ? "afterDelay" : "off"),
  });
  registerCommand({ id: "workbench.action.editor.nextChange", title: "Go to Next Change", category: "Editor", keybinding: "alt+f5", enabled: hasActiveFile, run: () => goToChange(1) });
  registerCommand({ id: "workbench.action.editor.previousChange", title: "Go to Previous Change", category: "Editor", keybinding: "shift+alt+f5", enabled: hasActiveFile, run: () => goToChange(-1) });

  // ── snippets ──
  registerCommand({ id: "workbench.action.openSnippets", title: "Configure User Snippets", category: "Snippets", enabled: userSnippetsAllowed, run: configureUserSnippets });
  registerCommand({
    id: "editor.action.insertSnippet",
    title: "Insert Snippet",
    category: "Snippets",
    enabled: () => userSnippetsAllowed() && !!(targetEditor() ?? codeEditorFor(get().activeGroup))?.getModel(),
    run: insertSnippet,
  });
}
