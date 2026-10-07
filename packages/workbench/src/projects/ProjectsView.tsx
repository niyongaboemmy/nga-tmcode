import { useEffect, useState, type ReactNode } from "react";
import { executeCommand } from "../commands/registry";
import { openContextMenu, useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows } from "../widgets/Skeleton";
import { changeCount } from "./plan";
import { lockReason, openProject, projectsSupported, refreshProjects, resolveConflict, setSharePresence, signIn, useProjects } from "./service";
import { showAssignment } from "./assignments";
import type { Link, Project, SyncState } from "./types";
import { openInTaskMentor, submitFromView } from "./commands";

const SYNC_LABEL: Record<SyncState, string> = {
  unbound: "Not a Task Mentor project",
  checking: "Checking…",
  synced: "Saved to Task Mentor",
  "local-changes": "Changes not saved to Task Mentor",
  "remote-changes": "Newer changes in Task Mentor",
  both: "Changes here and in Task Mentor",
  conflict: "Conflicts to resolve",
  saving: "Saving…",
  pulling: "Getting the latest…",
  offline: "Offline",
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

function Section({ title, actions, children, defaultOpen = true }: { title: string; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
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
        ]);
      }}
    >
      <Codicon name={p.kind === "github" ? "github" : "cloud"} className="tm-project-kind" />
      <span className="tm-project-name">{p.name}</span>
      {p.assignment && <Codicon name="mortar-board" className="tm-project-kind" title={`Assignment: ${p.assignment.title}`} />}
      {online && <span className="tm-live-dot" title="Open in TMCode now" aria-label="Open now" />}
      <span className="tm-project-meta">
        {p.language && <span className="tm-chip">{p.language}</span>}
        {ago(p.last_activity_at ?? p.updated_at)}
      </span>
      {current && <Codicon name="check" className="tm-project-current" aria-label="Open in this window" />}
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
          <b>{workspace.name}</b> is not a Task Mentor project yet. Connect it to save it online, continue on any computer and link it to your activities.
        </p>
        <button type="button" className="tm-button tm-button--block" onClick={() => executeCommand("projects.connectFolder")} title="Connect This Folder to Task Mentor" aria-label="Connect This Folder to Task Mentor" data-testid="connect-folder">
          <Codicon name="cloud-upload" />
          <span className="tm-button-label">Connect to Task Mentor</span>
        </button>
      </div>
    );
  }
  const busy = sync === "saving" || sync === "pulling" || sync === "checking";
  const links = Array.isArray(project?.links) ? (project!.links as Link[]) : [];
  return (
    <div className="tm-projects-folder" data-testid="project-folder">
      <div className="tm-projects-folder-head">
        <Codicon name={binding.kind === "github" ? "github" : "cloud"} />
        <b className="tm-project-name" title={project?.name ?? binding.name}>
          {project?.name ?? binding.name}
        </b>
        <span className="tm-chip">{binding.kind === "github" ? "GitHub" : "Task Mentor"}</span>
        <ActionButton
          icon="ellipsis"
          label="More Project Actions…"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.left, r.bottom + 2, [
              { kind: "item", label: "Open in Task Mentor", run: () => executeCommand("projects.openInTaskMentor") },
              ...(binding.kind === "tm" ? [{ kind: "item" as const, label: "Use as Starter for an Assignment…", run: () => executeCommand("assignments.useAsStarter") }] : []),
              { kind: "separator" },
              { kind: "item", label: "Disconnect This Folder…", run: () => executeCommand("projects.disconnect") },
            ]);
          }}
        />
      </div>
      {project?.assignment && (
        <button type="button" className="tm-project-assignment" onClick={() => showAssignment(project.assignment!.id, { toSide: true })} title="Show the assignment brief">
          <Codicon name="mortar-board" />
          <span className="tm-project-name">{project.assignment.title}</span>
          {project.read_only ? <span className="tm-chip">Read-only</span> : <Codicon name="chevron-right" />}
        </button>
      )}
      {binding.kind === "tm" ? (
        <>
          <div className={`tm-sync-line is-${sync}`} data-testid="sync-state">
            <Codicon name={SYNC_ICON[sync]} className={busy ? "codicon-modifier-spin" : ""} />
            <span>{SYNC_LABEL[sync]}</span>
            {plan && changeCount(plan.localChanges) > 0 && sync !== "saving" && <span className="tm-badge tm-badge--accent">{changeCount(plan.localChanges)}</span>}
          </div>
          {message && <p className="tm-muted tm-projects-hint">{message}</p>}
          {project?.status === "submitted" && (
            <div className="tm-projects-locked" data-testid="project-submitted">
              <Codicon name="lock" />
              <span>Submitted: it can't change until you withdraw the submission.</span>
              <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => executeCommand("projects.withdraw")}>
                Withdraw
              </button>
            </div>
          )}
          <div className="tm-projects-actions">
            <button type="button" className="tm-button" disabled={busy || !!lockReason(project)} onClick={() => executeCommand("projects.save")} data-testid="save-to-tm" title="Save to Task Mentor">
              <Codicon name="cloud-upload" />
              <span className="tm-button-label">Save</span>
            </button>
            <button type="button" className="tm-button tm-button--secondary" disabled={busy} onClick={() => executeCommand("projects.pull")} title="Get Latest from Task Mentor">
              <Codicon name="cloud-download" />
              <span className="tm-button-label">Get Latest</span>
            </button>
          </div>
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
      <div className="tm-projects-links">
        <div className="tm-projects-links-head">
          <span>Activities</span>
          <ActionButton icon="add" label="Link to an Activity…" onClick={() => executeCommand("projects.linkActivity")} />
        </div>
        {links.length === 0 && <p className="tm-muted tm-projects-hint">Link this project to a quiz, an assignment or a recorded assessment.</p>}
        {links.map((l) => (
          <div key={l.id} className="tm-list-row tm-link-row">
            <Codicon name={l.activity_type === "quiz" ? "checklist" : l.activity_type === "assignment" ? "notebook" : "graph"} />
            <span className="tm-project-name">{l.activity?.title ?? `${l.activity_type} ${l.activity_id}`}</span>
            {l.status === "submitted" ? (
              <span className="tm-chip is-success" title={l.submitted_at ?? ""}>
                Submitted{l.revision_number ? ` r${l.revision_number}` : l.git_commit ? ` ${l.git_commit.slice(0, 7)}` : ""}
              </span>
            ) : (
              <button type="button" className="tm-button tm-button--small" onClick={() => void submitFromView(l.id)} disabled={l.activity?.open === false}>
                Submit
              </button>
            )}
          </div>
        ))}
      </div>
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
  const match = (p: Project) => !filter || `${p.name} ${p.language ?? ""} ${p.repo_full_name ?? ""}`.toLowerCase().includes(filter.toLowerCase());
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
        {error && <p className="tm-error-text">{error}</p>}
        {list(mine, "No projects yet. Create one, or connect the open folder.")}
      </Section>
      <Section title="Shared with Me" defaultOpen={!!shared?.length}>
        {list(shared, "Projects others share with you on GitHub appear here.")}
      </Section>
    </div>
  );
}
