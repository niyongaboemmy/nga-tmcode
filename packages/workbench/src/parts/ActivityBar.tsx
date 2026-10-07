import { executeCommand, formatKeybinding, getCommand, keybindingFor } from "../commands/registry";
import { getPlatform, openContextMenu, showView, useWorkbench, type ViewId } from "../state/store";
import { Codicon } from "../widgets/icons";
import { useExam } from "../exam/state";
import { useUpdate } from "../update/updateService";
// ── git ──
import { useGit, useGitAllowed } from "../scm/gitService";
import { changeCount } from "../scm/model";
import { debugAllowed } from "../debug/debugService";
import { useProjects, signIn, signOut, refreshProjects } from "../projects/service";
import { useAssignments } from "../projects/assignments";
import type { AccountStatus } from "../platform/types";
// ── extension view containers (exthost/views) ──
import { useViews, type ViewContainer } from "../exthost/views/model";
import { useWebviews } from "../exthost/views/webviews";
import { ExtIcon } from "../exthost/views/ExtIcon";

const TASK_VIEW = { id: "task" as ViewId, icon: "mortar-board", label: "Task", command: "workbench.view.task" };
const VIEWS: { id: ViewId; icon: string; label: string; command: string }[] = [
  { id: "explorer", icon: "files", label: "Explorer", command: "workbench.view.explorer" },
  { id: "search", icon: "search", label: "Search", command: "workbench.view.search" },
  { id: "scm", icon: "source-control", label: "Source Control", command: "workbench.view.scm" },
  // ── Run and Debug ──
  { id: "debug", icon: "debug-alt", label: "Run and Debug", command: "workbench.view.debug" },
  // ── end Run and Debug ──
  { id: "testing", icon: "beaker", label: "Testing", command: "workbench.view.testing" },
];
// ── extensions (feat/extensions): hidden during exams ──
// ── Task Mentor projects: practice mode with an NGA account host ──
const PROJECTS_VIEW = { id: "projects" as ViewId, icon: "folder-library", label: "Task Mentor Projects", command: "workbench.view.projects" };
const ASSIGNMENTS_VIEW = { id: "assignments" as ViewId, icon: "mortar-board", label: "Assignments", command: "workbench.view.assignments" };
const EXTENSIONS_VIEW = { id: "extensions" as ViewId, icon: "extensions", label: "Extensions", command: "workbench.view.extensions" };

export function ActivityBar() {
  const activeView = useWorkbench((s) => s.activeView);
  const sidebarVisible = useWorkbench((s) => s.sidebarVisible);
  const dirtyCount = useWorkbench((s) => Object.keys(s.dirty).length);
  const failing = useWorkbench((s) => s.tests.items.filter((t) => t.status === "failed" || t.status === "error").length);
  const os = getPlatform().os;
  const inExam = useExam((s) => !!s.quiz);
  const updateReady = useUpdate((s) => s.status === "available");
  const practice = useWorkbench((s) => s.policy.mode === "practice");
  const gitAllowed = useGitAllowed();
  const scmChanges = useGit((s) => changeCount(s.status));
  // Run and Debug is hidden in exams unless the policy allows the debugger.
  useWorkbench((s) => s.policy);
  useExam((s) => s.phase);
  const hasAccount = !!getPlatform().account;
  const account = useProjects((s) => s.account);
  const projectSync = useProjects((s) => s.sync);
  // Assignments to start or finish (not submitted, not completed).
  const todo = useAssignments((s) => (s.student ?? []).filter((a) => !a.read_only && (!a.my || a.my.state === "not_started" || a.my.state === "in_progress")).length);
  const base = inExam ? [TASK_VIEW, ...VIEWS] : practice ? [...VIEWS, ...(hasAccount ? [PROJECTS_VIEW, ASSIGNMENTS_VIEW] : []), EXTENSIONS_VIEW] : VIEWS;
  const views = base.filter((v) => (v.id !== "scm" || gitAllowed) && (v.id !== "debug" || debugAllowed()));
  // Extensions never run in exams, so their containers only exist in practice mode.
  const extContainers = useViews((s) => s.containers).filter((c) => c.location === "activitybar" && practice && !inExam);

  const label = (v: (typeof VIEWS)[number]) => {
    const cmd = getCommand(v.command);
    const kb = cmd ? formatKeybinding(keybindingFor(cmd, os), os) : "";
    return kb ? `${v.label} (${kb})` : v.label;
  };

  return (
    <nav className="tm-activitybar" aria-label="Active View Switcher">
      <div className="tm-activitybar-top" role="tablist" aria-orientation="vertical">
        {views.map((v) => {
          const active = sidebarVisible && activeView === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`tm-activity ${active ? "is-active" : ""}`}
              title={label(v)}
              aria-label={label(v)}
              onClick={() => showView(v.id)}
            >
              <Codicon name={v.icon} />
              {v.id === "explorer" && dirtyCount > 0 && <span className="tm-activity-badge">{dirtyCount}</span>}
              {v.id === "scm" && scmChanges > 0 && <span className="tm-activity-badge">{scmChanges > 9999 ? "10k+" : scmChanges}</span>}
              {v.id === "testing" && failing > 0 && <span className="tm-activity-badge is-error">{failing}</span>}
              {v.id === "assignments" && todo > 0 && (
                <span className="tm-activity-badge" aria-label={`${todo} assignments to do`}>
                  {todo}
                </span>
              )}
              {v.id === "projects" && (projectSync === "conflict" || projectSync === "local-changes" || projectSync === "both") && (
                <span className={`tm-activity-badge ${projectSync === "conflict" ? "is-error" : ""}`} aria-label="Unsaved project changes">
                  {projectSync === "conflict" ? "!" : "↑"}
                </span>
              )}
            </button>
          );
        })}
        {extContainers.map((c) => (
          <ExtContainerButton key={c.key} container={c} active={sidebarVisible && activeView === c.key} />
        ))}
      </div>
      <div className="tm-activitybar-bottom">
        {hasAccount && practice && !inExam && <AccountButton account={account} />}
        <button
          type="button"
          className="tm-activity"
          title="Manage"
          aria-label="Manage"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenu(r.right + 4, r.bottom - 8, [
              { kind: "item", label: "Command Palette...", keybinding: formatKeybinding("mod+shift+p", os), run: () => executeCommand("workbench.action.showCommands") },
              { kind: "separator" },
              { kind: "item", label: "Settings", keybinding: formatKeybinding("mod+,", os), run: () => executeCommand("workbench.action.openSettings") },
              { kind: "item", label: "Keyboard Shortcuts", keybinding: formatKeybinding("mod+k mod+s", os), run: () => executeCommand("workbench.action.keybindingsReference") },
              ...(practice && !inExam ? [{ kind: "item" as const, label: "Extensions", keybinding: formatKeybinding("mod+shift+x", os), run: () => executeCommand("workbench.view.extensions") }] : []),
              { kind: "separator" },
              { kind: "item", label: "Themes", keybinding: formatKeybinding("mod+k mod+t", os), run: () => executeCommand("workbench.action.selectTheme") },
              { kind: "separator" },
              updateReady
                ? { kind: "item", label: `Install Update and Restart (${useUpdate.getState().info?.version})`, run: () => executeCommand("update.restartToUpdate") }
                : { kind: "item", label: "Check for Updates...", disabled: !getCommand("update.checkForUpdates")?.enabled?.(), run: () => executeCommand("update.checkForUpdates") },
            ]);
          }}
        >
          <Codicon name="settings-gear" />
          {updateReady && <span className="tm-activity-badge" aria-label="Update available">1</span>}
        </button>
      </div>
    </nav>
  );
}

/** An extension's view container: its icon (monochrome, like VS Code's), with the sum of its views' badges. */
function ExtContainerButton({ container, active }: { container: ViewContainer; active: boolean }) {
  const badge = useViews((s) => s.views.filter((v) => v.container === container.key).reduce((n, v) => n + (s.meta[v.id]?.badge?.value ?? 0), 0));
  const webBadge = useWebviews((s) => Object.values(s.entries).filter((e) => e.kind === "view" && useViews.getState().views.some((v) => v.id === e.viewType && v.container === container.key)).reduce((n, e) => n + (e.meta.badge?.value ?? 0), 0));
  const total = badge + webBadge;
  return (
    <button type="button" role="tab" aria-selected={active} className={`tm-activity ${active ? "is-active" : ""}`} title={container.title} aria-label={container.title} data-testid={`activity-${container.key}`} onClick={() => showView(container.key)}>
      <ExtIcon icon={container.icon} mask size={24} className="tm-activity-ext-icon" />
      {total > 0 && <span className="tm-activity-badge">{total}</span>}
    </button>
  );
}

/** VS Code's Accounts menu: the NGA account (Central MIS + Task Mentor). */
function AccountButton({ account }: { account: AccountStatus | null }) {
  const user = account?.signed_in ? account.user : null;
  const busy = account?.phase === "waiting" || account?.phase === "completing";
  const initials = (user?.name ?? user?.email ?? "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const title = user ? `${user.name ?? user.email} (NGA)` : busy ? "Signing in… (continue in your browser)" : "Accounts: Sign in with NGA";
  return (
    <button
      type="button"
      className="tm-activity tm-account-button"
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      data-testid="account-button"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openContextMenu(
          r.right + 4,
          r.bottom - 8,
          user
            ? [
                { kind: "item", label: `${user.name ?? user.email}${user.role ? ` · ${user.role}` : ""}`, disabled: true, run: () => {} },
                { kind: "separator" },
                { kind: "item", label: "Task Mentor Projects", run: () => executeCommand("workbench.view.projects") },
                { kind: "item", label: "Refresh Projects", run: () => void refreshProjects() },
                { kind: "separator" },
                { kind: "item", label: "Sign Out", run: () => void signOut() },
              ]
            : [
                busy
                  ? { kind: "item", label: "Cancel Sign In", run: () => void getPlatform().account?.cancel() }
                  : { kind: "item", label: "Sign in with NGA (Central MIS + Task Mentor)", run: () => void signIn() },
              ],
        );
      }}
    >
      {user ? <span className="tm-account-avatar">{initials || <Codicon name="account" />}</span> : <Codicon name={busy ? "loading" : "account"} className={busy ? "codicon-modifier-spin" : ""} />}
      {!user && account?.error && <span className="tm-activity-badge is-error" aria-label="Signed out">!</span>}
    </button>
  );
}
