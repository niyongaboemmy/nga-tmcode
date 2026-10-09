import { currentActivity, useActivity } from "../state/activity";
import { executeCommand } from "../commands/registry";
import { languageLabel } from "../monaco/documents";
import { activeFilePath, showPanel, useWorkbench } from "../state/store";
import { Codicon } from "../widgets/icons";
import { SyncStatus } from "../exam/ExamViews";
import { showReleaseNotes, useUpdate } from "../update/updateService";
// ── Task Mentor projects ──
import { useProjects } from "../projects/service";
import { changeCount as planChanges } from "../projects/plan";
import { SYNC_ICON } from "../projects/ProjectsView";
// ── git ──
import { useGit, useGitAllowed } from "../scm/gitService";
import { branchLabel } from "../scm/model";
import { useDebug } from "../debug/debugService";
// ── Run hub ──
import { RunMenuHost, RunStatusItems } from "../run/RunHubViews";
import { ExtensionStatusItems } from "../exthost/ui";

const MODE_LABEL = { practice: "Practice", monitored: "Monitored exam", secure: "Secure exam" } as const;
const MODE_ICON = { practice: "beaker", monitored: "eye", secure: "shield" } as const;

function Item({
  children,
  title,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  className?: string;
}) {
  if (!onClick) {
    return (
      <span className={`tm-status-item ${className}`} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" className={`tm-status-item is-clickable ${className}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

function UpdateItem() {
  const { status, info, progress } = useUpdate();
  if (status === "available" && info) {
    return (
      <Item className="tm-status-update" title={`TMCode ${info.version} is available — click for details`} onClick={() => void showReleaseNotes()}>
        <Codicon name="arrow-circle-up" /> Update to {info.version}
      </Item>
    );
  }
  if (status === "downloading" || status === "installing") {
    return (
      <Item className="tm-status-update" title="Updating TMCode">
        <Codicon name="loading" className="codicon-modifier-spin" />
        {status === "installing" ? "Installing update…" : `Downloading update ${progress ?? 0}%`}
      </Item>
    );
  }
  return null;
}

/** VS Code's branch and Synchronize Changes items (practice mode only). */
function GitItems() {
  const allowed = useGitAllowed();
  const status = useGit((s) => s.status);
  const remoteOp = useGit((s) => s.remoteOp);
  const busy = useGit((s) => s.busy);
  if (!allowed || !status) return null;
  const label = branchLabel(status);
  const syncTitle = remoteOp
    ? "Synchronizing Changes..."
    : status.upstream
      ? `${status.upstream}: ${status.behind} commit${status.behind === 1 ? "" : "s"} to pull, ${status.ahead} to push — Synchronize Changes`
      : `Publish to ${status.remotes.length ? "a remote" : "GitHub"}`;
  return (
    <>
      <Item className="tm-status-git" title={`${status.branch ?? "Detached HEAD"}, Checkout Branch/Tag...`} onClick={() => executeCommand("git.checkout")}>
        <Codicon name={busy === "Checking out" ? "loading" : status.branch ? "git-branch" : "git-commit"} className={busy === "Checking out" ? "codicon-modifier-spin" : ""} />
        <span data-testid="git-branch">{label}</span>
      </Item>
      {status.branch && (
        <Item className="tm-status-git tm-prio-mid" title={syncTitle} onClick={() => executeCommand("git.sync")}>
          <Codicon name={remoteOp ? "sync" : status.upstream ? "sync" : "cloud-upload"} className={remoteOp ? "codicon-modifier-spin" : ""} />
          {status.upstream && (status.behind > 0 || status.ahead > 0) && (
            <span data-testid="git-ahead-behind">
              {status.behind}↓ {status.ahead}↑
            </span>
          )}
        </Item>
      )}
    </>
  );
}

// ── Task Mentor project: sync state of the open folder ──
function ProjectStatus() {
  const binding = useProjects((s) => s.binding);
  const sync = useProjects((s) => s.sync);
  const plan = useProjects((s) => s.plan);
  if (!binding || binding.kind !== "tm") return null;
  const n = plan ? planChanges(plan.localChanges) : 0;
  const busy = sync === "saving" || sync === "pulling" || sync === "checking";
  const label = sync === "synced" ? "Task Mentor" : sync === "local-changes" || sync === "both" ? `${n} to save` : sync === "remote-changes" ? "Updates" : sync === "conflict" ? "Conflicts" : sync === "offline" ? "Offline" : busy ? (sync === "saving" ? "Saving…" : sync === "pulling" ? "Updating…" : "Task Mentor") : "Task Mentor";
  const title =
    sync === "synced"
      ? `${binding.name}: everything is saved to Task Mentor`
      : sync === "local-changes" || sync === "both"
        ? `${binding.name}: ${n} change(s) not saved to Task Mentor — click to save`
        : sync === "remote-changes"
          ? `${binding.name}: newer changes in Task Mentor — click to get them`
          : `${binding.name}: ${sync}`;
  return (
    <Item
      className={`tm-status-project is-${sync}`}
      title={title}
      onClick={() => executeCommand(sync === "remote-changes" ? "projects.pull" : sync === "conflict" || sync === "offline" || sync === "error" ? "workbench.view.projects" : "projects.save")}
    >
      <Codicon name={SYNC_ICON[sync]} className={busy ? "codicon-modifier-spin" : ""} />
      <span data-testid="project-status">{label}</span>
    </Item>
  );
}

// ── Run and Debug: the orange bar and the session name, as in VS Code ──
function DebugStatus() {
  const name = useDebug((s) => (s.phase === "inactive" ? null : s.sessionName));
  if (!name) return null;
  return (
    <Item className="tm-status-debug" title="Select and Start Debug Configuration" onClick={() => executeCommand("workbench.view.debug")}>
      <Codicon name="debug-alt" /> {name}
    </Item>
  );
}
// ── end Run and Debug ──

/** "Saving to Task Mentor…": what is in flight, shown the moment it starts. */
function BusyItem() {
  const label = useActivity((s) => currentActivity(s.running));
  if (!label) return null;
  return (
    <span className="tm-status-item tm-status-busy" role="status" aria-live="polite" data-testid="status-busy" title={label}>
      <Codicon name="loading" className="codicon-modifier-spin" />
      <span>{label}</span>
    </span>
  );
}

export function StatusBar({ chord }: { chord: string | null }) {
  const mode = useWorkbench((s) => s.policy.mode);
  const problems = useWorkbench((s) => s.problems);
  const cursor = useWorkbench((s) => s.cursor);
  const language = useWorkbench((s) => s.activeLanguage);
  const eol = useWorkbench((s) => s.eol);
  const tabSize = useWorkbench((s) => s.settings["editor.tabSize"]);
  const spaces = useWorkbench((s) => s.settings["editor.insertSpaces"]);
  const hasFile = useWorkbench((s) => !!activeFilePath(s));
  const dirtyCount = useWorkbench((s) => Object.keys(s.dirty).length);
  const autoSave = useWorkbench((s) => s.settings["files.autoSave"]);
  const notifications = useWorkbench((s) => s.notifications.length);
  const debugging = useDebug((s) => s.phase !== "inactive");
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  return (
    <footer className={`tm-statusbar is-${mode} ${debugging ? "is-debugging" : ""}`} role="status" aria-label="Status Bar">
      <div className="tm-status-left">
        <Item className="tm-status-mode" title={`TMCode — ${MODE_LABEL[mode]}`}>
          <Codicon name={MODE_ICON[mode]} />
          <span>{MODE_LABEL[mode]}</span>
        </Item>
        <GitItems />
        <ProjectStatus />
        <SyncStatus />
        <BusyItem />
        <Item title={`Errors: ${errors}, Warnings: ${warnings}`} onClick={() => showPanel("problems")}>
          <Codicon name="error" /> {errors} <Codicon name="warning" /> {warnings}
        </Item>
        {dirtyCount > 0 && autoSave === "off" && (
          <Item title={`${dirtyCount} unsaved file${dirtyCount > 1 ? "s" : ""}`} onClick={() => executeCommand("workbench.action.files.saveAll")}>
            <Codicon name="circle-filled" className="tm-status-unsaved" /> {dirtyCount} unsaved
          </Item>
        )}
        <DebugStatus />
        <RunStatusItems />
        <ExtensionStatusItems side="left" />
        {chord && <Item title="Waiting for second key of chord">({chord}) was pressed. Waiting for second key of chord...</Item>}
      </div>
      <div className="tm-status-right">
        {hasFile && (
          <>
            <Item title="Go to Line/Column" onClick={() => executeCommand("workbench.action.gotoLine")}>
              Ln {cursor.line}, Col {cursor.column}
              {cursor.selected > 0 && ` (${cursor.selected} selected)`}
            </Item>
            <Item className="tm-prio-low" title="Indentation (Settings)" onClick={() => executeCommand("workbench.action.openSettings")}>
              {spaces ? "Spaces" : "Tab Size"}: {tabSize}
            </Item>
            <Item className="tm-prio-low" title="Encoding">UTF-8</Item>
            <Item className="tm-prio-low" title="End of Line Sequence">{eol}</Item>
            <Item className="tm-prio-mid" title="Language Mode">{languageLabel(language)}</Item>
          </>
        )}
        <Item className="tm-prio-low" title={autoSave === "off" ? "Auto Save is off" : "Auto Save is on"} onClick={() => executeCommand("workbench.action.openSettings")}>
          <Codicon name={autoSave === "off" ? "circle-slash" : "check-all"} />
          {autoSave === "off" ? "Auto Save Off" : "Auto Save"}
        </Item>
        <ExtensionStatusItems side="right" />
        <UpdateItem />
        <Item title={notifications ? `${notifications} notifications` : "No Notifications"}>
          <Codicon name={notifications ? "bell-dot" : "bell"} />
        </Item>
      </div>
      <RunMenuHost />
    </footer>
  );
}
