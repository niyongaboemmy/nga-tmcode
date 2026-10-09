import { useActivity } from "../state/activity";
import { useEffect, useState, type ReactNode } from "react";
import { executeCommand } from "../commands/registry";
import { openContextMenu, useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows } from "../widgets/Skeleton";
import { changeCount } from "./plan";
import { loadRemoved, lockReason, openProject, projectsSupported, refreshProjects, removeProject, resolveConflict, restoreProject, setSharePresence, signIn, useProjects } from "./service";
import { showAssignment, useAssignments } from "./assignments";
import type { Link, Project, SyncState } from "./types";
import { openInTaskMentor } from "./commands";
import { dueText, TYPE_LABEL } from "./matching";

/** Short: the sync row shares the side bar's width with Save. The tooltip says it in full. */
const SYNC_LABEL: Record<SyncState, string> = {
  unbound: "Not connected",
  checking: "Checking…",
  synced: "Saved online",
  "local-changes": "Not saved yet",
  "remote-changes": "Newer version online",
  both: "Changed here and online",
  conflict: "Conflicts to resolve",
  saving: "Saving…",
  pulling: "Getting the latest…",
  offline: "Offline",
  error: "Sync problem",
};
const SYNC_TIP: Record<SyncState, string> = {
  unbound: "This folder is not a Task Mentor project",
  checking: "Comparing this folder with Task Mentor",
  synced: "Everything here is saved to Task Mentor",
  "local-changes": "Changes in this folder are not saved to Task Mentor yet: Save",
  "remote-changes": "Task Mentor has newer changes: Get Latest",
  both: "Changes here and in Task Mentor: Save and Get Latest",
  conflict: "The same files changed here and in Task Mentor",
  saving: "Saving to Task Mentor",
  pulling: "Getting the latest from Task Mentor",
  offline: "Task Mentor can't be reached",
  error: "Sync problem",
};

export const SYNC_ICON: Record<SyncState, string> = {
  unbound: "circle-slash",
  checking: "sync",
  synced: "cloud",
  "local-changes": "cloud-upload",
  "remote-changes": "cloud-download",
  both: "arrow-swap",
  conflict: "warning",
  saving: "sync",
  pulling: "sync",
  offline: "debug-disconnect",
  error: "error",
};

function Section({ title, actions, children, defaultOpen = true, onOpen }: { title: string; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean; onOpen?: () => void }) {
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (v) onOpen?.();
  };
  return (
    <section className={`tm-pane tm-projects-section ${open ? "is-open" : "is-collapsed"}`} aria-label={title}>
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">{title}</span>
        {actions && (
          <div className="tm-pane-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && <div className="tm-pane-body tm-projects-body">{children}</div>}
    </section>
  );
}

function ago(iso: string | null | undefined) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function ProjectRow({ p, current }: { p: Project; current: boolean }) {
  const online = p.presence?.online;
  const status = p.status ?? "draft";
  return (
    <div
      className={`tm-list-row tm-project-row ${current ? "is-current" : ""}`}
      role="button"
      tabIndex={0}
      data-testid="project-row"
      title={`${p.name}${p.description ? ` — ${p.description}` : ""}\n${p.kind === "github" ? `GitHub: ${p.repo_full_name ?? p.repo_url}` : "Saved in Task Mentor"}`}
      onClick={() => void openProject(p.id)}
      onKeyDown={(e) => e.key === "Enter" && void openProject(p.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { kind: "item", label: "Open in TMCode", run: () => void openProject(p.id) },
          { kind: "item", label: "Open in Task Mentor", run: () => openInTaskMentor(p.id) },
          ...(p.assignment ? [{ kind: "item" as const, label: "Show Assignment Brief", run: () => showAssignment(p.assignment!.id) }] : []),
          ...(current ? [{ kind: "separator" as const }, { kind: "item" as const, label: "Disconnect This Folder…", run: () => executeCommand("projects.disconnect") }] : []),
          ...(p.my_role === "owner" && status === "draft" ? [{ kind: "separator" as const }, { kind: "item" as const, label: "Remove Project…", run: () => void removeProject(p) }] : []),
        ]);
      }}
    >
      <Codicon name={p.kind === "github" ? "github" : "cloud"} className="tm-project-kind" />
      <span className="tm-assignment-text">
        <span className="tm-project-name">
          {p.name}
          {online && <span className="tm-live-dot" title="Open in TMCode now" aria-label="Open now" />}
        </span>
        <span className="tm-assignment-sub">
          {status !== "draft" && <StatusChip status={status} />}
          {p.assignment ? (
            <span className="tm-assignment-course" title={`For: ${p.assignment.title}`}>
              <Codicon name="mortar-board" /> {p.assignment.title === p.name ? "Assignment" : p.assignment.title}
            </span>
          ) : (
            p.language && <span>{p.language}</span>
          )}
          <span>{ago(p.last_activity_at ?? p.updated_at)}</span>
        </span>
      </span>
      {current && (
        <span className="tm-open-here" title="This project is the folder open in this window">
          <Codicon name="folder-opened" /> Open here
        </span>
      )}
    </div>
  );
}

function ThisFolder() {
  const binding = useProjects((s) => s.binding);
  const project = useProjects((s) => s.current);
  const sync = useProjects((s) => s.sync);
  const plan = useProjects((s) => s.plan);
  const message = useProjects((s) => s.syncMessage);
  const workspace = useWorkbench((s) => s.workspace);
  if (!workspace) return <p className="tm-muted tm-projects-hint">Open a project below, or open a folder to connect it to Task Mentor.</p>;
  if (!binding) {
    return (
      <div className="tm-projects-connect">
        <p className="tm-muted">
          <b>{workspace.name}</b> is only on this computer. Connect it to save it online, continue on any computer, and hand it in for an assignment or quiz.
        </p>
        <button type="button" className="tm-button tm-button--block" onClick={() => executeCommand("projects.connectFolder")} title="Connect This Folder to Task Mentor" aria-label="Connect This Folder to Task Mentor" data-testid="connect-folder">
          <Codicon name="cloud-upload" />
          <span className="tm-button-label">Connect to Task Mentor</span>
        </button>
      </div>
    );
  }
  // Saving starts with a scan of the folder: the button says so from the click, not after the scan.
  const saving = useActivity((s) => s.running.some((r) => r.label.startsWith("Saving to Task Mentor") || r.label === "Submitting…"));
  const busy = saving || sync === "saving" || sync === "pulling" || sync === "checking";
  const links = Array.isArray(project?.links) ? (project!.links as Link[]) : [];
  const changes = plan ? changeCount(plan.localChanges) : 0;
  return (
    <div className="tm-projects-folder" data-testid="project-folder">
      <div className="tm-projects-folder-head">
        <Codicon name={binding.kind === "github" ? "github" : "cloud"} />
        <b className="tm-project-name" title={project?.name ?? binding.name}>
          {project?.name ?? binding.name}
        </b>
        <ActionButton
          icon="ellipsis"
          label="More Project Actions…"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.left, r.bottom + 2, [
              { kind: "item", label: "Open in Task Mentor", run: () => executeCommand("projects.openInTaskMentor") },
              ...(binding.kind === "tm" ? [{ kind: "item" as const, label: "Get Latest from Task Mentor", run: () => executeCommand("projects.pull") }] : []),
              ...(binding.kind === "tm" ? [{ kind: "item" as const, label: "Use as Starter for an Assignment…", run: () => executeCommand("assignments.useAsStarter") }] : []),
              { kind: "separator" },
              { kind: "item", label: "Disconnect This Folder…", run: () => executeCommand("projects.disconnect") },
              ...(project && (project.status ?? "draft") === "draft" ? [{ kind: "item" as const, label: "Remove Project…", run: () => executeCommand("projects.remove") }] : []),
            ]);
          }}
        />
      </div>
      {project && <AssessmentCard project={project} links={links} busy={busy} />}
      {binding.kind === "tm" ? (
        <>
          <div className={`tm-sync-line is-${sync}`} data-testid="sync-state" title={SYNC_TIP[sync]}>
            <Codicon name={SYNC_ICON[sync]} className={busy ? "codicon-modifier-spin" : ""} />
            <span>{SYNC_LABEL[sync]}</span>
            {changes > 0 && sync !== "saving" && (
              <span className="tm-badge tm-badge--accent" title={`${changes} changed file${changes === 1 ? "" : "s"}`}>
                {changes}
              </span>
            )}
            <span className="tm-sync-actions">
              <button
                type="button"
                className={`tm-button tm-button--small ${changes > 0 || sync === "local-changes" ? "" : "tm-button--secondary"}`}
                disabled={busy || !!lockReason(project)}
                onClick={() => executeCommand("projects.save")}
                data-testid="save-to-tm"
                title={lockReason(project) ?? "Save to Task Mentor (⌘⌥U)"}
              >
                <Codicon name={saving ? "loading" : "cloud-upload"} className={saving ? "codicon-modifier-spin" : ""} /> {saving ? "Saving…" : "Save"}
              </button>
              <ActionButton icon="cloud-download" label="Get Latest from Task Mentor" disabled={busy} onClick={() => executeCommand("projects.pull")} />
            </span>
          </div>
          {message && <p className="tm-muted tm-projects-hint">{message}</p>}
          {plan && plan.conflicts.length > 0 && (
            <div className="tm-projects-conflicts" data-testid="conflicts">
              <p>These files changed here and in Task Mentor:</p>
              {plan.conflicts.map((path) => (
                <div key={path} className="tm-list-row">
                  <Codicon name="warning" />
                  <span className="tm-project-name">{path}</span>
                  <ActionButton icon="check" label="Keep Mine" onClick={() => void resolveConflict(path, "mine")} />
                  <ActionButton icon="cloud-download" label="Take Task Mentor's" onClick={() => void resolveConflict(path, "theirs")} />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="tm-sync-line is-synced">
          <Codicon name="git-branch" />
          <span>{project?.git ? `${project.git.branch ?? "detached"} · ${project.git.ahead}↑ ${project.git.behind}↓ · reported to Task Mentor` : "Task Mentor follows your pushes"}</span>
        </div>
      )}
      {project && <SharePresence project={project} />}
    </div>
  );
}

/** One vocabulary for students everywhere (Assignments says "In progress" too). */
export const STATUS_LABEL = { draft: "In progress", submitted: "Submitted", graded: "Graded", removed: "Removed" } as const;
type Status = keyof typeof STATUS_LABEL;

export function StatusChip({ status }: { status?: Status }) {
  const s = status ?? "draft";
  return (
    <span className={`tm-chip tm-status-chip is-${s}`} data-testid="project-status-chip">
      {STATUS_LABEL[s]}
    </span>
  );
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/**
 * What this project is for, where it stands (In progress → Submitted →
 * Graded) and the one thing to do next: match it, submit it, withdraw it, or
 * read the grade.
 */
function AssessmentCard({ project, links, busy }: { project: Project; links: Link[]; busy: boolean }) {
  const status: Status = project.status ?? "draft";
  const link = links.find((l) => l.activity_type === "assignment") ?? links[0] ?? null;
  const assignment = useAssignments((s) => (project.assignment ? s.student?.find((a) => a.id === project.assignment!.id) : undefined));
  const steps: Status[] = ["draft", "submitted", "graded"];
  const at = steps.indexOf(status);
  const title = link?.activity?.title ?? project.assignment?.title ?? (link ? `${TYPE_LABEL[link.activity_type].one} ${link.activity_id}` : null);
  const kind = link ? (link.question_id ? "Quiz practical" : TYPE_LABEL[link.activity_type].one) : project.assignment ? "Assignment" : null;
  const due = dueText(link?.activity?.due_date ?? assignment?.due_date, link?.activity?.open !== false && !project.read_only);
  const closed = link?.activity?.open === false;
  const openBrief = project.assignment ? () => showAssignment(project.assignment!.id, { toSide: true }) : undefined;

  if (status === "removed") {
    return (
      <div className="tm-assess-card is-removed" data-testid="project-status-panel" data-status="removed">
        <div className="tm-projects-locked">
          <Codicon name="trash" />
          <span>Removed. Restore it to work on it again.</span>
          <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => executeCommand("projects.restore")}>
            Restore
          </button>
        </div>
      </div>
    );
  }
  if (!title) {
    return (
      <div className="tm-assess-card is-unmatched" data-testid="project-status-panel" data-status={status}>
        <div className="tm-assess-empty">
          <Codicon name="link" />
          <span>
            <b>Not for an assessment yet</b>
            <small>Match it with an assignment or quiz to hand it in.</small>
          </span>
        </div>
        <button type="button" className="tm-button tm-button--block" onClick={() => executeCommand("projects.linkActivity")} data-testid="match-assessment">
          <Codicon name="link" />
          <span className="tm-button-label">Match with an Assessment…</span>
        </button>
      </div>
    );
  }
  return (
    <div className={`tm-assess-card is-${status}`} data-testid="project-status-panel" data-status={status}>
      <div className="tm-assess-head">
        <Codicon name={link ? (link.question_id ? "beaker" : TYPE_LABEL[link.activity_type].icon) : "notebook"} className="tm-assess-icon" />
        <span className="tm-assess-title-wrap">
          {openBrief ? (
            <button type="button" className="tm-assess-title is-link" onClick={openBrief} title="Show the brief" data-testid="project-assessment">
              {title}
            </button>
          ) : (
            <span className="tm-assess-title" data-testid="project-assessment" title={title}>
              {title}
            </span>
          )}
          <span className="tm-assess-sub">
            {kind}
            {due && <span className={`tm-assess-due ${/was due|closed/.test(due) ? "is-late" : /today|tomorrow/.test(due) ? "is-soon" : ""}`}> · {due}</span>}
            {project.read_only && <span> · read-only</span>}
          </span>
        </span>
      </div>
      <ol className="tm-status-steps" aria-label="Project status" data-testid="project-steps">
        {steps.map((st, i) => (
          <li key={st} className={`${i < at ? "is-done" : ""} ${i === at ? "is-current" : ""}`} aria-current={i === at ? "step" : undefined}>
            <span className="tm-status-dot">{i < at ? <Codicon name="check" /> : null}</span>
            <span>{STATUS_LABEL[st]}</span>
          </li>
        ))}
      </ol>
      {status === "draft" && (
        <>
          <button
            type="button"
            className="tm-button tm-button--block"
            disabled={busy || !!project.read_only || closed}
            onClick={() => executeCommand("projects.submit")}
            data-testid="submit-project"
            title={closed ? "This assessment is closed" : "Save, then hand in this exact version"}
          >
            <Codicon name="send" />
            <span className="tm-button-label">{closed ? "Closed for Submissions" : "Submit Project"}</span>
          </button>
          <button type="button" className="tm-link-button tm-assess-change" onClick={() => executeCommand("projects.linkActivity")} data-testid="change-assessment">
            Change assessment…
          </button>
        </>
      )}
      {status === "submitted" && (
        <div className="tm-assess-locked" data-testid="project-submitted">
          <span>
            <Codicon name="lock" /> Handed in{link?.revision_number ? ` (version ${link.revision_number})` : ""}
            {link?.submitted_at ? `, ${when(link.submitted_at)}` : ""}. Locked until graded.
          </span>
          <button type="button" className="tm-link-button" onClick={() => executeCommand("projects.withdraw")} title="Unlock it to change your work, then submit again">
            Withdraw to make changes
          </button>
        </div>
      )}
      {status === "graded" &&
        (assignment?.my?.grade != null ? (
          <div className="tm-assess-grade" data-testid="project-grade">
            <span className="tm-assess-score">
              <b>{assignment.my.grade}</b> / {assignment.my.max_points ?? assignment.points ?? "–"}
            </span>
            {assignment.my.feedback && <p className="tm-assess-feedback">{assignment.my.feedback}</p>}
          </div>
        ) : (
          <button type="button" className="tm-button tm-button--secondary tm-button--block" onClick={() => executeCommand("projects.openInTaskMentor")} data-testid="project-grade">
            <Codicon name="link-external" /> See Your Grade in Task Mentor
          </button>
        ))}
    </div>
  );
}

/** "Share live status": whether teachers' monitors see that this project is open (locked on for open assignments). */
function SharePresence({ project }: { project: Project }) {
  const shared = project.share_presence !== false;
  const locked = !!project.assignment && !project.read_only;
  return (
    <label className={`tm-switch-row ${locked ? "is-locked" : ""}`} title={locked ? "Teachers follow assignment workspaces while the assignment is open." : "Teachers can see when you work on this project"}>
      <input
        type="checkbox"
        role="switch"
        className="tm-switch"
        checked={shared || locked}
        disabled={locked}
        data-testid="share-presence"
        onChange={(e) => void setSharePresence(project.id, e.target.checked)}
      />
      <span>
        Share live status with teachers
        <small className="tm-muted">{locked ? "Required while the assignment is open" : shared ? "Teachers see when this project is open" : "Only you see when this project is open"}</small>
      </span>
    </label>
  );
}

/** The Task Mentor Projects view in the activity bar. */
export function ProjectsView() {
  const account = useProjects((s) => s.account);
  const mine = useProjects((s) => s.mine);
  const shared = useProjects((s) => s.shared);
  const loading = useProjects((s) => s.loading);
  const error = useProjects((s) => s.error);
  const binding = useProjects((s) => s.binding);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "submitted" | "graded">("all");
  const removed = useProjects((s) => s.removed);

  useEffect(() => {
    if (account?.signed_in && mine === null) void refreshProjects();
  }, [account?.signed_in, mine]);

  if (!projectsSupported()) {
    return <div className="tm-view-empty">Task Mentor projects are available in the TMCode desktop app, outside exams.</div>;
  }
  if (!account?.signed_in) {
    const busy = account?.phase === "waiting" || account?.phase === "completing";
    return (
      <div className="tm-view-empty tm-projects-signin" data-testid="projects-signin">
        <Codicon name="folder-library" className="tm-projects-hero" />
        <h3>Your projects, everywhere</h3>
        <p>Sign in with your NGA account to sync your Task Mentor projects, save your work, link it to quizzes and assignments, and continue on any computer.</p>
        <button type="button" className="tm-button tm-button--block" disabled={busy} onClick={() => void signIn()} data-testid="projects-signin-button">
          <Codicon name={busy ? "loading" : "account"} className={busy ? "codicon-modifier-spin" : ""} /> {busy ? "Continue in your browser…" : "Sign in with NGA"}
        </button>
        <p className="tm-muted">One sign-in for Central MIS and Task Mentor. Google sign-in works too.</p>
        {account?.error && <p className="tm-error-text">{account.error}</p>}
      </div>
    );
  }
  const match = (p: Project) =>
    (!filter || `${p.name} ${p.language ?? ""} ${p.repo_full_name ?? ""} ${p.assignment?.title ?? ""}`.toLowerCase().includes(filter.toLowerCase())) &&
    (statusFilter === "all" || (p.status ?? "draft") === statusFilter);
  const counts = { all: mine?.length ?? 0, draft: 0, submitted: 0, graded: 0 };
  for (const p of mine ?? []) {
    const st = (p.status ?? "draft") as keyof typeof counts;
    if (st in counts) counts[st]++;
  }
  const list = (items: Project[] | null, empty: string) =>
    items === null ? (
      <SkeletonRows rows={4} label="Loading projects" />
    ) : items.filter(match).length === 0 ? (
      <p className="tm-muted tm-projects-hint">{filter ? "No matching projects." : empty}</p>
    ) : (
      items.filter(match).map((p) => <ProjectRow key={p.id} p={p} current={binding?.project_id === p.id} />)
    );

  return (
    <div className="tm-projects-view" data-testid="projects-view">
      <Section title="This Folder">
        <ThisFolder />
      </Section>
      <Section
        title="My Projects"
        actions={
          <>
            <ActionButton icon="add" label="New Project…" onClick={() => executeCommand("projects.new")} />
            <ActionButton icon="refresh" label="Refresh" onClick={() => void refreshProjects()} className={loading ? "is-busy" : ""} />
          </>
        }
      >
        <div className="tm-input-box tm-projects-filter">
          <input className="tm-input" placeholder="Filter projects" aria-label="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {mine?.some((p) => p.status) && (
          <div className="tm-status-filters" role="radiogroup" aria-label="Filter by status">
            {(["all", "draft", "submitted", "graded"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={statusFilter === k} className={`tm-filter-chip ${statusFilter === k ? "is-active" : ""}`} onClick={() => setStatusFilter(k)} data-testid={`status-filter-${k}`}>
                {k === "all" ? "All" : STATUS_LABEL[k]}
                {k !== "all" && <span>{counts[k]}</span>}
              </button>
            ))}
          </div>
        )}
        {error && <p className="tm-error-text">{error}</p>}
        {list(mine, "No projects yet. Create one, or connect the open folder.")}
      </Section>
      <Section title="Shared with Me" defaultOpen={!!shared?.length}>
        {list(shared, "Projects others share with you on GitHub appear here.")}
      </Section>
      <Section title="Removed" defaultOpen={false} onOpen={() => removed === null && void loadRemoved()}>
        {removed === null ? (
          <SkeletonRows rows={2} label="Loading removed projects" />
        ) : removed.length === 0 ? (
          <p className="tm-muted tm-projects-hint">Removed projects appear here. You can restore them.</p>
        ) : (
          removed.map((p) => (
            <div key={p.id} className="tm-list-row tm-project-row is-removed" data-testid="removed-project-row">
              <Codicon name="trash" className="tm-project-kind" />
              <span className="tm-project-name">{p.name}</span>
              <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => void restoreProject(p.id)}>
                Restore
              </button>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
