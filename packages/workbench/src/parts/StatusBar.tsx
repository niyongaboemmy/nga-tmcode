import { useRef } from "react";
import { toggleNotificationCenter, unreadCount, useNotificationCenter } from "../state/notificationCenter";
import { currentActivity, useActivity } from "../state/activity";
import { executeCommand } from "../commands/registry";
import { languageLabel } from "../monaco/documents";
import { useDetectedLanguage } from "../monaco/smartEditor";
import { activeFilePath, showPanel, useWorkbench } from "../state/store";
import { Codicon } from "../widgets/icons";
import { SyncStatus } from "../exam/ExamViews";
import { showReleaseNotes, useUpdate } from "../update/updateService";
// ── Task Mentor projects ──
import { isAssignmentWorkspace, useProjects } from "../projects/service";
import { showAssignment, STUDENT_STATUS_LABEL, useAssignments } from "../projects/assignments";
import { deriveStatus } from "../projects/status";
import { changeCount as planChanges } from "../projects/plan";
import { SYNC_ICON, SYNC_LABEL, SYNC_TIP, SYNC_TONE } from "../projects/syncLabels";
import type { SyncState } from "../projects/types";
// ── git ──
import { useGit, useGitAllowed } from "../scm/gitService";
import { branchLabel } from "../scm/model";
import { useDebug } from "../debug/debugService";
// ── Run hub ──
import { RunMenuHost, RunStatusItems } from "../run/RunHubViews";
import { ExtensionStatusItems } from "../exthost/ui";
import { encodingLabel, pickEncoding, pickEol, pickIndentation, pickLanguage, toggleScreenReaderMode, useActiveFileInfo } from "./editorStatus";

// TMCode has no lab lockdown yet, so a "secure" exam runs exactly like a monitored one and says so.
const MODE_LABEL = { practice: "Practice", monitored: "Monitored exam", secure: "Monitored exam" } as const;
const MODE_ICON = { practice: "beaker", monitored: "eye", secure: "eye" } as const;
const MODE_TITLE = {
  practice: "TMCode: Practice",
  monitored: "TMCode: Monitored exam. Task Mentor records your saves and runs.",
  secure: "TMCode: Monitored exam. Your teacher chose lab lockdown, which TMCode doesn't offer yet, so this exam is monitored.",
} as const;

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
  const message = useProjects((s) => s.syncMessage);
  // A quick re-check after each edit doesn't flash "Checking…": the last answer stays until the new one.
  const shown = useRef<SyncState>("synced");
  if (sync !== "checking" || shown.current === "unbound") shown.current = sync;
  // An assignment workspace: the same one status as the brief and the side bar (W4), then the sync state.
  const current = useProjects((s) => s.current);
  const assignment = useAssignments((s) => (current?.assignment ? (s.student?.find((a) => a.id === current.assignment!.id) ?? null) : null));
  if (!binding || binding.kind !== "tm") return null;
  const view = assignment && current?.id === binding.project_id ? deriveStatus(assignment, current, { here: true }) : null;
  const n = plan ? planChanges(plan.localChanges) : 0;
  const state = sync === "checking" ? shown.current : sync;
  const busy = sync === "saving" || sync === "pulling";
  // The same words as the Projects view's sync line (projects/syncLabels.ts).
  const label = SYNC_LABEL[state];
  const tip = `${binding.name}: ${SYNC_TIP[state]}${(state === "local-changes" || state === "both") && n ? ` (${n} change${n === 1 ? "" : "s"})` : ""}${state === "error" && message ? ` — ${message}` : ""}`;
  return (
    <Item
      className={`tm-status-project is-${state} tm-tone-${SYNC_TONE[state]}`}
      title={tip}
      onClick={() =>
        state === "remote-changes"
          ? executeCommand("projects.pull")
          : state === "conflict" || state === "offline" || state === "error"
            ? // Students' home for an assignment is its brief (N6), not the Projects view.
              view
              ? showAssignment(assignment!.id, { toSide: true })
              : executeCommand("workbench.view.projects")
            : executeCommand("projects.save")
      }
    >
      <Codicon name={SYNC_ICON[state]} className={busy ? "codicon-modifier-spin" : ""} />
      {view && (
        <span className="tm-status-student" data-testid="project-student-status" data-status={view.status}>
          {view.syncing ? "Updating…" : STUDENT_STATUS_LABEL[view.status]} ·
        </span>
      )}
      <span data-testid="project-status" data-state={state}>
        {label}
      </span>
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

/** The language of the active editor; an untitled editor's guessed language says "(auto detected)". */
function LanguageItem({ language }: { language: string | null }) {
  const path = useWorkbench((s) => activeFilePath(s));
  const detected = useDetectedLanguage((s) => !!path && !!s.paths[path]);
  return (
    <Item className="tm-prio-mid tm-status-language" title={detected ? "Select Language Mode (auto detected)" : "Select Language Mode"} onClick={() => void pickLanguage()}>
      {languageLabel(language)}
      {detected && <span className="tm-status-detected"> (auto detected)</span>}
    </Item>
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
  const assignmentWork = useProjects((s) => isAssignmentWorkspace(s.current));
  const notifications = useWorkbench((s) => s.notifications.length);
  const dnd = useNotificationCenter((s) => s.dnd);
  // Things from outside (new work, grades, returned work) not seen yet.
  const unread = useNotificationCenter((s) => unreadCount(s.history));
  const debugging = useDebug((s) => s.phase !== "inactive");
  const fileInfo = useActiveFileInfo();
  const screenReader = useWorkbench((s) => s.settings["editor.accessibilitySupport"] === "on");
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  return (
    <footer className={`tm-statusbar is-${mode} ${debugging ? "is-debugging" : ""}`} role="status" aria-label="Status Bar">
      <div className="tm-status-left">
        <Item className="tm-status-mode" title={MODE_TITLE[mode]}>
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
            <Item className="tm-prio-low tm-status-indent" title="Select Indentation" onClick={() => void pickIndentation()}>
              {fileInfo.path ? (fileInfo.insertSpaces ? "Spaces" : "Tab Size") : spaces ? "Spaces" : "Tab Size"}: {fileInfo.path ? fileInfo.tabSize : tabSize}
            </Item>
            <Item className={`tm-prio-low tm-status-encoding ${fileInfo.encoding && fileInfo.encoding !== "utf8" ? "is-non-default" : ""}`} title="Select Encoding" onClick={() => void pickEncoding()}>
              {encodingLabel(fileInfo.encoding)}
            </Item>
            <Item className="tm-prio-low tm-status-eol" title="Select End of Line Sequence" onClick={() => void pickEol()}>
              {eol}
            </Item>
            <LanguageItem language={language} />
          </>
        )}
        {screenReader && (
          <Item className="tm-prio-low" title="Screen reader mode is on. Click to turn it off." onClick={toggleScreenReaderMode}>
            Screen Reader Optimized
          </Item>
        )}
        {/* Assignment work has one saving story (the brief's line); the disk Auto Save item would be a second one. */}
        {!assignmentWork && (
          <Item className="tm-prio-low" title={autoSave === "off" ? "Auto Save is off" : "Auto Save is on"} onClick={() => executeCommand("workbench.action.openSettings")}>
            <Codicon name={autoSave === "off" ? "circle-slash" : "check-all"} />
            {autoSave === "off" ? "Auto Save Off" : "Auto Save"}
          </Item>
        )}
        <ExtensionStatusItems side="right" />
        <UpdateItem />
        <Item
          className="tm-status-bell"
          title={`${dnd ? "Do Not Disturb" : notifications ? `${notifications} notifications` : "No Notifications"}${unread ? ` · ${unread} unread` : ""}`}
          onClick={toggleNotificationCenter}
        >
          <Codicon name={dnd ? "bell-slash" : notifications || unread ? "bell-dot" : "bell"} />
          {unread > 0 && (
            <span className="tm-status-unread" data-testid="notifications-unread" aria-label={`${unread} unread`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Item>
      </div>
      <RunMenuHost />
    </footer>
  );
}
