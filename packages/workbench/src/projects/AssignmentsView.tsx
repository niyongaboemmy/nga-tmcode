import { useEffect, useState, type ReactNode } from "react";
import { openContextMenu, useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows } from "../widgets/Skeleton";
import { dueLabel, groupAssignments, isOpenWorkspaceOf, refreshAssignments, showAssignment, startAssignment, submitAssignment, useAssignments, type AssignmentSummary } from "./assignments";
import { projectsSupported, signIn, useProjects } from "./service";
import { openAssignmentInTaskMentor } from "./commands";

function Section({ title, count, children, defaultOpen = true, actions }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`tm-pane tm-projects-section ${open ? "is-open" : "is-collapsed"}`} aria-label={title}>
      <div className="tm-pane-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} />
        <span className="tm-pane-title">{title}</span>
        {count !== undefined && count > 0 && <span className="tm-badge">{count}</span>}
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

export const STATE_LABEL = { not_started: "Not started", in_progress: "In progress", submitted: "Submitted", graded: "Graded" } as const;

function StateChip({ a }: { a: AssignmentSummary }) {
  if (a.read_only) return <span className="tm-chip">Read-only</span>;
  const s = a.my?.state ?? "not_started";
  if (s === "graded") return <span className="tm-chip is-success">{a.my?.grade ?? "–"}/{a.my?.max_points ?? a.points ?? "–"}</span>;
  if (s === "submitted") return <span className="tm-chip is-success">Submitted</span>;
  if (s === "in_progress") return <span className="tm-chip is-info">In progress</span>;
  return null;
}

function AssignmentRow({ a, teaching }: { a: AssignmentSummary; teaching?: boolean }) {
  const busy = useAssignments((s) => s.busy[a.id]);
  useProjects((s) => s.binding);
  const due = dueLabel(a.due_date);
  const open = !teaching && isOpenWorkspaceOf(a);
  const started = !!a.my?.project_id;
  return (
    <div
      className={`tm-list-row tm-assignment-row ${open ? "is-current" : ""}`}
      role="button"
      tabIndex={0}
      data-testid="assignment-row"
      data-assignment-id={a.id}
      title={`${a.title}\n${a.course_name ?? ""}${a.due_date ? ` · due ${new Date(a.due_date).toLocaleString()}` : ""}`}
      onClick={() => showAssignment(a.id)}
      onKeyDown={(e) => e.key === "Enter" && showAssignment(a.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { kind: "item", label: "Show Brief", run: () => showAssignment(a.id) },
          ...(!teaching && (started || !a.read_only) ? [{ kind: "item" as const, label: started ? "Continue in TMCode" : "Start", run: () => void startAssignment(a.id) }] : []),
          ...(!teaching && started && !a.read_only ? [{ kind: "item" as const, label: "Submit…", run: () => void submitAssignment(a.id) }] : []),
          { kind: "separator" },
          { kind: "item", label: "Open in Task Mentor", run: () => openAssignmentInTaskMentor(a.id) },
        ]);
      }}
    >
      <Codicon name={a.kind === "case_study" ? "book" : "beaker"} className="tm-project-kind" />
      <span className="tm-assignment-text">
        <span className="tm-project-name">{a.title}</span>
        <span className="tm-assignment-sub">
          {a.course_name && <span className="tm-assignment-course">{a.course_name}</span>}
          {teaching && a.teaching ? (
            <span>
              {a.teaching.submitted}/{a.teaching.students} submitted
            </span>
          ) : (
            due && !a.read_only && a.my?.state !== "graded" && a.my?.state !== "submitted" && <span className={`tm-due is-${due.tone}`}>{due.text}</span>
          )}
        </span>
      </span>
      {!teaching && <StateChip a={a} />}
      {open && <Codicon name="check" className="tm-project-current" aria-label="Open in this window" />}
      {!teaching && !a.read_only && !started && (
        <button
          type="button"
          className="tm-button tm-button--small"
          disabled={!!busy}
          onClick={(e) => {
            e.stopPropagation();
            void startAssignment(a.id);
          }}
        >
          {busy === "starting" ? "Starting…" : "Start"}
        </button>
      )}
    </div>
  );
}

/** The Assignments view: TMCode practicals and case studies from Task Mentor. */
export function AssignmentsView() {
  const account = useProjects((s) => s.account);
  const student = useAssignments((s) => s.student);
  const teaching = useAssignments((s) => s.teaching);
  const loading = useAssignments((s) => s.loading);
  const error = useAssignments((s) => s.error);
  const workspace = useWorkbench((s) => s.workspace);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (account?.signed_in && student === null) void refreshAssignments();
  }, [account?.signed_in, student]);
  // Due countdowns stay current while the view is open.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  void workspace;

  if (!projectsSupported()) return <div className="tm-view-empty">Assignments are available in the TMCode desktop app, outside exams.</div>;
  if (!account?.signed_in) {
    return (
      <div className="tm-view-empty tm-projects-signin" data-testid="assignments-signin">
        <Codicon name="mortar-board" className="tm-projects-hero" />
        <h3>Practicals and case studies</h3>
        <p>Sign in with your NGA account to see the coding assignments of your subjects, start them with your teacher's starter files, and submit from here.</p>
        <button type="button" className="tm-button tm-button--block" onClick={() => void signIn()}>
          <Codicon name="account" /> Sign in with NGA
        </button>
      </div>
    );
  }
  const match = (a: AssignmentSummary) => !filter || `${a.title} ${a.course_name ?? ""} ${a.language ?? ""}`.toLowerCase().includes(filter.toLowerCase());
  const groups = groupAssignments((student ?? []).filter(match));
  const rows = (list: AssignmentSummary[], empty: string, t?: boolean) =>
    list.length === 0 ? <p className="tm-muted tm-projects-hint">{empty}</p> : list.map((a) => <AssignmentRow key={a.id} a={a} teaching={t} />);
  const teach = (teaching ?? []).filter(match);
  const nothing = student !== null && student.length === 0 && teach.length === 0;

  return (
    <div className="tm-projects-view" data-testid="assignments-view">
      <div className="tm-assignments-toolbar">
        <div className="tm-input-box tm-assignments-filter">
          <input className="tm-input" placeholder="Filter assignments" aria-label="Filter assignments" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <ActionButton icon="refresh" label="Refresh" onClick={() => void refreshAssignments()} className={loading ? "is-busy" : ""} />
      </div>
      {error && <p className="tm-error-text">{error}</p>}
      {student === null && !error ? (
        <SkeletonRows rows={4} label="Loading assignments" />
      ) : nothing ? (
        <div className="tm-view-empty">
          <Codicon name="mortar-board" className="tm-projects-hero" />
          <p>No coding assignments yet. When a teacher publishes a TMCode practical or case study for your subjects, it appears here.</p>
        </div>
      ) : (
        <>
          {(student?.length ?? 0) > 0 && (
            <>
              <Section title="To Do" count={groups.todo.length}>
                {rows(groups.todo, filter ? "No matching assignments." : "Nothing to do. Well done!")}
              </Section>
              {groups.submitted.length > 0 && (
                <Section title="Submitted" count={groups.submitted.length}>
                  {rows(groups.submitted, "")}
                </Section>
              )}
              {groups.graded.length > 0 && (
                <Section title="Graded" count={groups.graded.length}>
                  {rows(groups.graded, "")}
                </Section>
              )}
              {groups.completed.length > 0 && (
                <Section title="Completed (Read-only)" count={groups.completed.length} defaultOpen={false}>
                  {rows(groups.completed, "")}
                </Section>
              )}
            </>
          )}
          {teach.length > 0 && (
            <Section title="Teaching" count={teach.length}>
              {rows(teach, "", true)}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
