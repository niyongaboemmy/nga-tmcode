import { registerCommand } from "../commands/registry";
import { onDocumentSaved } from "../monaco/documents";
import {
  activeEditor,
  focusNeighbourGroup,
  getPlatform,
  onWorkspaceChanged,
  openFile,
  openSpecialEditor,
  setEditorSticky,
  setWorkspaceSettingsText,
  splitEditor,
  useWorkbench,
} from "../state/store";
import { WORKSPACE_SETTINGS_FILE } from "../state/settingsJson";
import type { SplitDirection } from "../state/layout";
import { registerTerminalCommands } from "../terminal/commands";
import { registerScmExtras } from "../scm/extras";
import { registerTrustCommands } from "../trust/trust";

/**
 * Commands and wiring for editor groups (grid, pin), settings.json and the
 * folder's .vscode/settings.json, terminal profiles/split/rename, git hunks
 * and conflicts, and workspace trust. Kept out of commands/builtin.ts.
 */
let registered = false;
export function registerWorkbenchExtras() {
  if (registered) return;
  registered = true;

  // ── editor groups ──
  const dirs: [SplitDirection, string][] = [
    ["right", "Right"],
    ["down", "Down"],
    ["left", "Left"],
    ["up", "Up"],
  ];
  for (const [dir, label] of dirs) {
    registerCommand({ id: `workbench.action.splitEditor${label}`, title: `Split Editor ${label}`, category: "View", enabled: () => !!activeEditor(), run: () => splitEditor(dir) });
  }
  registerCommand({
    id: "workbench.action.splitEditorOrthogonal",
    title: "Split Editor in Orthogonal Direction",
    category: "View",
    keybinding: "mod+k mod+\\",
    enabled: () => !!activeEditor(),
    run: () => splitEditor("down"),
  });
  const focusDirs: [SplitDirection, string, string][] = [
    ["left", "Left", "left"],
    ["right", "Right", "right"],
    ["up", "Above", "up"],
    ["down", "Below", "down"],
  ];
  for (const [dir, label, key] of focusDirs) {
    registerCommand({
      id: `workbench.action.focus${label}Group`,
      title: `Focus ${label === "Above" ? "Editor Group Above" : label === "Below" ? "Editor Group Below" : `${label} Editor Group`}`,
      category: "View",
      keybinding: `mod+k mod+${key}`,
      run: () => focusNeighbourGroup(dir),
    });
  }
  const pinTarget = () => {
    const s = useWorkbench.getState();
    const e = activeEditor(s);
    return e ? { group: s.activeGroup, e } : null;
  };
  registerCommand({
    id: "workbench.action.pinEditor",
    title: "Pin Editor",
    category: "View",
    keybinding: "mod+k shift+enter",
    enabled: () => !!pinTarget(),
    // ⌘K ⇧Enter toggles, as in VS Code (Unpin has the same keys when the tab is pinned).
    run: () => {
      const t = pinTarget();
      if (t) setEditorSticky(t.group, t.e.id, !t.e.sticky);
    },
  });
  registerCommand({
    id: "workbench.action.unpinEditor",
    title: "Unpin Editor",
    category: "View",
    enabled: () => !!pinTarget()?.e.sticky,
    run: () => {
      const t = pinTarget();
      if (t) setEditorSticky(t.group, t.e.id, false);
    },
  });

  // ── settings ──
  registerCommand({ id: "workbench.action.openSettingsJson", title: "Open User Settings (JSON)", category: "Preferences", run: () => openSpecialEditor("settingsJson") });
  registerCommand({
    id: "workbench.action.openWorkspaceSettingsFile",
    title: "Open Workspace Settings (JSON)",
    category: "Preferences",
    enabled: () => !!useWorkbench.getState().workspaceSettings,
    run: () => openFile(WORKSPACE_SETTINGS_FILE, { pinned: true }),
  });
  wireWorkspaceSettings();

  registerTerminalCommands();
  registerScmExtras();
  registerTrustCommands();
}

// ── the folder's .vscode/settings.json (read-only overlay) ──

let wsSeq = 0;
async function readWorkspaceSettings() {
  const mine = ++wsSeq;
  const root = useWorkbench.getState().workspace?.root;
  if (!root) return setWorkspaceSettingsText(null);
  const text = await getPlatform()
    .fs.readFile(WORKSPACE_SETTINGS_FILE)
    .catch(() => null);
  // Another folder opened meanwhile: its own read wins.
  if (mine !== wsSeq || useWorkbench.getState().workspace?.root !== root) return;
  setWorkspaceSettingsText(text);
}

function wireWorkspaceSettings() {
  onWorkspaceChanged(() => {
    setWorkspaceSettingsText(null);
    void readWorkspaceSettings();
  });
  onDocumentSaved((path) => path === WORKSPACE_SETTINGS_FILE && void readWorkspaceSettings());
  getPlatform().watch?.((paths) => {
    if (paths.some((p) => p === WORKSPACE_SETTINGS_FILE || p === ".vscode")) void readWorkspaceSettings();
  });
  // A folder already open when the workbench starts.
  if (useWorkbench.getState().workspace) void readWorkspaceSettings();
}
