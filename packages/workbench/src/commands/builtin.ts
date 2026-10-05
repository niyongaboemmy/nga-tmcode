import { registerCommand } from "./registry";
import { saveAll, saveDocument } from "../monaco/documents";
import { codeEditorFor, runEditorAction } from "../monaco/editors";
import {
  activeEditor,
  activeFilePath,
  beginExplorerEdit,
  closeActiveEditor,
  closeAllEditors,
  collapseAll,
  deleteEntry,
  getPlatform,
  notify,
  openFolder,
  openQuickInput,
  openSpecialEditor,
  refreshExplorer,
  revealView,
  showPanel,
  splitEditor,
  targetFolder,
  togglePanel,
  togglePanelMaximized,
  toggleSidebar,
  updateSetting,
  useWorkbench,
  workbench,
} from "../state/store";

const hasWorkspace = () => !!useWorkbench.getState().workspace;
const hasActiveFile = () => !!activeFilePath();
const terminalAllowed = () => {
  const { policy } = useWorkbench.getState();
  return policy.terminal !== "off";
};

let registered = false;

export function registerBuiltinCommands() {
  if (registered) return;
  registered = true;
  const group = () => workbench.get().activeGroup;

  // ── File ──
  registerCommand({ id: "workbench.action.files.openFolder", title: "Open Folder...", category: "File", keybinding: "mod+o", run: openFolder });
  registerCommand({
    id: "explorer.newFile",
    title: "New File...",
    category: "File",
    keybinding: "mod+alt+n",
    enabled: hasWorkspace,
    run: () => beginExplorerEdit({ mode: "newFile", target: targetFolder() }),
  });
  registerCommand({
    id: "explorer.newFolder",
    title: "New Folder...",
    category: "File",
    enabled: hasWorkspace,
    run: () => beginExplorerEdit({ mode: "newFolder", target: targetFolder() }),
  });
  registerCommand({
    id: "workbench.action.files.save",
    title: "Save",
    category: "File",
    keybinding: "mod+s",
    enabled: hasActiveFile,
    run: async () => {
      const path = activeFilePath();
      if (!path) return;
      if (useWorkbench.getState().settings["editor.formatOnSave"]) {
        await codeEditorFor(group())?.getAction("editor.action.formatDocument")?.run();
      }
      await saveDocument(path);
    },
  });
  registerCommand({ id: "workbench.action.files.saveAll", title: "Save All", category: "File", keybinding: "mod+alt+s", run: saveAll });
  registerCommand({ id: "workbench.action.closeActiveEditor", title: "Close Editor", category: "View", keybinding: "mod+w", run: closeActiveEditor });
  registerCommand({ id: "workbench.action.closeAllEditors", title: "Close All Editors", category: "View", keybinding: "mod+k mod+w", run: closeAllEditors });
  registerCommand({
    id: "workbench.action.closeFolder",
    title: "Close Folder",
    category: "Workspaces",
    keybinding: "mod+k f",
    enabled: hasWorkspace,
    run: async () => {
      await closeAllEditors();
      if (Object.keys(useWorkbench.getState().dirty).length) return;
      workbench.set({ workspace: null, dirs: {}, expanded: {}, selection: null });
      openSpecialEditor("welcome");
    },
  });
  registerCommand({
    id: "deleteFile",
    title: "Delete",
    category: "File",
    hidden: true,
    enabled: () => useWorkbench.getState().selection != null,
    run: () => {
      const sel = useWorkbench.getState().selection;
      if (sel) void deleteEntry(sel);
    },
  });
  registerCommand({
    id: "renameFile",
    title: "Rename...",
    category: "File",
    hidden: true,
    keybinding: "f2",
    enabled: () => useWorkbench.getState().selection != null && document.activeElement?.closest(".tm-explorer") != null,
    run: () => {
      const sel = useWorkbench.getState().selection;
      if (sel) void beginExplorerEdit({ mode: "rename", target: sel });
    },
  });
  registerCommand({ id: "workbench.files.action.refreshFilesExplorer", title: "Refresh Explorer", category: "File", enabled: hasWorkspace, run: refreshExplorer });
  registerCommand({ id: "workbench.files.action.collapseExplorerFolders", title: "Collapse Folders in Explorer", category: "View", run: collapseAll });

  // ── Go / quick input ──
  registerCommand({ id: "workbench.action.showCommands", title: "Show All Commands", category: "View", keybinding: "mod+shift+p", run: () => openQuickInput("commands") });
  registerCommand({ id: "workbench.action.showCommands.f1", title: "Show All Commands", hidden: true, keybinding: "f1", run: () => openQuickInput("commands") });
  registerCommand({ id: "workbench.action.quickOpen", title: "Go to File...", category: "Go", keybinding: "mod+p", enabled: hasWorkspace, run: () => openQuickInput("files") });
  registerCommand({ id: "workbench.action.gotoLine", title: "Go to Line/Column...", category: "Go", keybinding: "ctrl+g", enabled: hasActiveFile, run: () => openQuickInput("line") });
  registerCommand({ id: "workbench.action.selectTheme", title: "Color Theme", category: "Preferences", keybinding: "mod+k mod+t", run: () => openQuickInput("theme") });

  // ── View ──
  registerCommand({ id: "workbench.action.toggleSidebarVisibility", title: "Toggle Primary Side Bar Visibility", category: "View", keybinding: "mod+b", run: () => toggleSidebar() });
  registerCommand({ id: "workbench.view.explorer", title: "Show Explorer", category: "View", keybinding: "mod+shift+e", run: () => revealView("explorer") });
  registerCommand({ id: "workbench.view.search", title: "Show Search", category: "View", keybinding: "mod+shift+f", enabled: hasWorkspace, run: () => revealView("search") });
  registerCommand({ id: "workbench.action.togglePanel", title: "Toggle Panel Visibility", category: "View", keybinding: "mod+j", run: () => togglePanel() });
  registerCommand({ id: "workbench.action.toggleMaximizedPanel", title: "Toggle Maximized Panel", category: "View", run: togglePanelMaximized });
  registerCommand({ id: "workbench.actions.view.problems", title: "Show Problems", category: "View", keybinding: "mod+shift+m", run: () => showPanel("problems") });
  registerCommand({ id: "workbench.action.output.toggleOutput", title: "Show Output", category: "View", keybinding: "mod+shift+u", run: () => showPanel("output") });
  registerCommand({ id: "workbench.action.splitEditor", title: "Split Editor", category: "View", keybinding: "mod+\\", enabled: () => !!activeEditor(), run: () => splitEditor() });
  registerCommand({
    id: "editor.action.fontZoomIn",
    title: "Editor Font Zoom In",
    category: "Editor",
    keybinding: "mod+=",
    run: () => updateSetting("editor.fontSize", Math.min(40, useWorkbench.getState().settings["editor.fontSize"] + 1)),
  });
  registerCommand({
    id: "editor.action.fontZoomOut",
    title: "Editor Font Zoom Out",
    category: "Editor",
    keybinding: "mod+-",
    run: () => updateSetting("editor.fontSize", Math.max(8, useWorkbench.getState().settings["editor.fontSize"] - 1)),
  });
  registerCommand({
    id: "editor.action.toggleWordWrap",
    title: "Toggle Word Wrap",
    category: "View",
    keybinding: "alt+z",
    run: () => updateSetting("editor.wordWrap", useWorkbench.getState().settings["editor.wordWrap"] === "on" ? "off" : "on"),
  });
  registerCommand({
    id: "editor.action.toggleMinimap",
    title: "Toggle Minimap",
    category: "View",
    run: () => updateSetting("editor.minimap.enabled", !useWorkbench.getState().settings["editor.minimap.enabled"]),
  });

  // ── Editor actions (delegated to Monaco) ──
  const editorAction = (id: string, title: string, action: string, keybinding?: string, category = "Editor") =>
    registerCommand({ id, title, category, keybinding, enabled: hasActiveFile, run: () => runEditorAction(group(), action) });
  editorAction("editor.action.formatDocument", "Format Document", "editor.action.formatDocument", "shift+alt+f");
  editorAction("actions.find", "Find", "actions.find");
  editorAction("editor.action.startFindReplaceAction", "Replace", "editor.action.startFindReplaceAction");
  editorAction("editor.action.commentLine", "Toggle Line Comment", "editor.action.commentLine");
  editorAction("editor.action.rename", "Rename Symbol", "editor.action.rename");
  editorAction("editor.action.revealDefinition", "Go to Definition", "editor.action.revealDefinition", undefined, "Go");
  editorAction("editor.foldAll", "Fold All", "editor.foldAll");
  editorAction("editor.unfoldAll", "Unfold All", "editor.unfoldAll");
  editorAction("undo", "Undo", "undo", undefined, "Edit");
  editorAction("redo", "Redo", "redo", undefined, "Edit");

  // ── Terminal ──
  registerCommand({
    id: "workbench.action.terminal.toggleTerminal",
    title: "Toggle Terminal",
    category: "View",
    keybinding: "ctrl+`",
    enabled: terminalAllowed,
    run: () => {
      const s = useWorkbench.getState();
      if (s.panelVisible && s.activePanel === "terminal") togglePanel(false);
      else showPanel("terminal");
    },
  });
  registerCommand({
    id: "workbench.action.terminal.new",
    title: "Create New Terminal",
    category: "Terminal",
    keybinding: "ctrl+shift+`",
    enabled: terminalAllowed,
    run: () => {
      showPanel("terminal");
      window.dispatchEvent(new CustomEvent("tmcode:new-terminal"));
    },
  });

  // ── Preferences / help ──
  registerCommand({ id: "workbench.action.openSettings", title: "Open Settings", category: "Preferences", keybinding: "mod+,", run: () => openSpecialEditor("settings") });
  registerCommand({ id: "workbench.action.keybindingsReference", title: "Keyboard Shortcuts Reference", category: "Help", keybinding: "mod+k mod+s", run: () => openSpecialEditor("shortcuts") });
  registerCommand({ id: "workbench.action.openWelcome", title: "Welcome", category: "Help", run: () => openSpecialEditor("welcome") });
  registerCommand({
    id: "workbench.action.showAbout",
    title: "About",
    category: "Help",
    run: () => notify("info", `TMCode ${getPlatform().version} — the New Generation Academy code editor for Task Mentor.`),
  });
}
