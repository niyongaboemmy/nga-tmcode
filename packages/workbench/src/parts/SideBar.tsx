import type { ReactNode } from "react";
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
import { ProjectsView } from "../projects/ProjectsView";
import { TimelinePane } from "../history/TimelinePane";
import { OutlinePane } from "../outline/OutlinePane";
import type { ContextMenuItem, ViewId } from "../state/store";
// ── extension views (exthost/views) ──
import { ExtViewPanes } from "../exthost/views/ViewPanes";
import { useViews } from "../exthost/views/model";

const TITLES = { explorer: "Explorer", search: "Search", testing: "Testing", task: "Task", scm: "Source Control", debug: "Run and Debug", extensions: "Extensions", projects: "Task Mentor Projects" } as const;

/** The title bar's "…" menu, per view. */
function moreActions(view: ViewId): ContextMenuItem[] {
  if (view.startsWith("ext:")) return [{ kind: "item", label: "Hide Primary Side Bar", run: () => executeCommand("workbench.action.toggleSidebarVisibility") }];
  if (view === "projects") {
    return [
      { kind: "item", label: "New Project…", run: () => executeCommand("projects.new") },
      { kind: "item", label: "Connect This Folder to Task Mentor…", run: () => executeCommand("projects.connectFolder") },
      { kind: "item", label: "Refresh", run: () => executeCommand("projects.refresh") },
      { kind: "item", label: "Open Project in Task Mentor", run: () => executeCommand("projects.openInTaskMentor") },
      { kind: "separator" },
      { kind: "item", label: "Sign Out of NGA", run: () => executeCommand("projects.signOut") },
    ];
  }
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

/** A built-in view with the extension views contributed to it below. */
function WithExtViews({ container, children }: { container: string; children: ReactNode }) {
  const has = useViews((s) => s.views.some((v) => v.container === container));
  if (!has) return <>{children}</>;
  return (
    <div className="tm-explorer-stack">
      {children}
      <ExtViewPanes container={container} />
    </div>
  );
}

export function SideBar() {
  const view = useWorkbench((s) => s.activeView);
  const extTitle = useViews((s) => s.containers.find((c) => c.key === view)?.title);
  const title = view.startsWith("ext:") ? (extTitle ?? "") : TITLES[view as keyof typeof TITLES];
  return (
    <aside className="tm-sidebar" aria-label={title}>
      <header className="tm-sidebar-title">
        <h2>{title}</h2>
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
        {view === "explorer" ? (
          <div className="tm-explorer-stack">
            <ExplorerView />
            <OutlinePane />
            <TimelinePane />
            <ExtViewPanes container="explorer" />
          </div>
        ) : view === "search" ? (
          <SearchView />
        ) : view === "task" ? (
          <TaskView />
        ) : view === "scm" ? (
          <WithExtViews container="scm">
            <ScmView />
          </WithExtViews>
        ) : view === "debug" ? (
          <WithExtViews container="debug">
            <RunDebugView />
          </WithExtViews>
        ) : view === "extensions" ? (
          <ExtensionsView />
        ) : view === "projects" ? (
          <ProjectsView />
        ) : view.startsWith("ext:") ? (
          <ExtViewPanes container={view} fill />
        ) : (
          <WithExtViews container="testing">
            <TestingView />
          </WithExtViews>
        )}
      </div>
    </aside>
  );
}
