import { executeCommand } from "../commands/registry";
import { openContextMenu, useWorkbench } from "../state/store";
import { ActionButton } from "../widgets/icons";
import { ExplorerView } from "./explorer/ExplorerView";
import { SearchView } from "./search/SearchView";
import { TestingView } from "./testing/TestingView";

const TITLES = { explorer: "Explorer", search: "Search", testing: "Testing" } as const;

export function SideBar() {
  const view = useWorkbench((s) => s.activeView);
  return (
    <aside className="tm-sidebar" aria-label={TITLES[view]}>
      <header className="tm-sidebar-title">
        <h2>{TITLES[view]}</h2>
        <div className="tm-sidebar-title-actions">
          <ActionButton
            icon="ellipsis"
            label="Views and More Actions..."
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu(r.left, r.bottom + 2, [
                { kind: "item", label: "Open Folder...", run: () => executeCommand("workbench.action.files.openFolder") },
                { kind: "item", label: "Refresh Explorer", run: () => executeCommand("workbench.files.action.refreshFilesExplorer") },
                { kind: "item", label: "Collapse Folders", run: () => executeCommand("workbench.files.action.collapseExplorerFolders") },
                { kind: "separator" },
                { kind: "item", label: "Hide Primary Side Bar", run: () => executeCommand("workbench.action.toggleSidebarVisibility") },
              ]);
            }}
          />
        </div>
      </header>
      <div className="tm-sidebar-content">
        {view === "explorer" ? <ExplorerView /> : view === "search" ? <SearchView /> : <TestingView />}
      </div>
    </aside>
  );
}
