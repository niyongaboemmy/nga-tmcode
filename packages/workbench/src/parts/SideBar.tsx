import { executeCommand } from "../commands/registry";
import { openContextMenu, useWorkbench } from "../state/store";
import { ActionButton } from "../widgets/icons";
import { ExplorerView } from "./explorer/ExplorerView";
import { SearchView } from "./search/SearchView";
import { TestingView } from "./testing/TestingView";
import { TaskView } from "../exam/ExamViews";
// ── git ──
import { ScmTitleActions, ScmView } from "../scm/ScmView";
// ── extensions ──
import { ExtensionsView, ExtensionsTitleActions } from "./extensions/ExtensionsView";
import { RunDebugView } from "../debug/RunDebugView";
import type { ContextMenuItem } from "../state/store";

const TITLES = { explorer: "Explorer", search: "Search", testing: "Testing", task: "Task", scm: "Source Control", debug: "Run and Debug", extensions: "Extensions" } as const;

/** The title bar's "…" menu, per view. */
function moreActions(view: keyof typeof TITLES): ContextMenuItem[] {
  if (view === "debug") {
    return [
      { kind: "item", label: "Add Configuration...", run: () => executeCommand("debug.addConfiguration") },
      { kind: "item", label: "Select and Start Debugging", run: () => executeCommand("workbench.action.debug.selectandstart") },
      { kind: "item", label: "Remove All Breakpoints", run: () => executeCommand("workbench.debug.viewlet.action.removeAllBreakpoints") },
      { kind: "separator" },
      { kind: "item", label: "How to Install a Language...", run: () => executeCommand("tmcode.installGuide") },
      { kind: "item", label: "Open Debug Console", run: () => executeCommand("workbench.debug.action.toggleRepl") },
      { kind: "separator" },
      { kind: "item", label: "Hide Primary Side Bar", run: () => executeCommand("workbench.action.toggleSidebarVisibility") },
    ];
  }
  return [
    { kind: "item", label: "Open Folder...", run: () => executeCommand("workbench.action.files.openFolder") },
    { kind: "item", label: "Refresh Explorer", run: () => executeCommand("workbench.files.action.refreshFilesExplorer") },
    { kind: "item", label: "Collapse Folders", run: () => executeCommand("workbench.files.action.collapseExplorerFolders") },
    { kind: "separator" },
    { kind: "item", label: "Hide Primary Side Bar", run: () => executeCommand("workbench.action.toggleSidebarVisibility") },
  ];
}

export function SideBar() {
  const view = useWorkbench((s) => s.activeView);
  return (
    <aside className="tm-sidebar" aria-label={TITLES[view]}>
      <header className="tm-sidebar-title">
        <h2>{TITLES[view]}</h2>
        <div className="tm-sidebar-title-actions">
          {view === "extensions" && <ExtensionsTitleActions />}
          {view === "scm" ? (
            <ScmTitleActions />
          ) : (
            <ActionButton
              icon="ellipsis"
              label="Views and More Actions..."
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openContextMenu(r.left, r.bottom + 2, moreActions(view));
              }}
            />
          )}
        </div>
      </header>
      <div className="tm-sidebar-content">
        {view === "explorer" ? <ExplorerView /> : view === "search" ? <SearchView /> : view === "task" ? <TaskView /> : view === "scm" ? <ScmView /> : view === "debug" ? <RunDebugView /> : view === "extensions" ? <ExtensionsView /> : <TestingView />}
      </div>
    </aside>
  );
}
