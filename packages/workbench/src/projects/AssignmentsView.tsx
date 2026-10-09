import { useEffect, useState, type ReactNode } from "react";
import { openContextMenu, useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows } from "../widgets/Skeleton";
import { dueLabel, groupAssignments, isOpenWorkspaceOf, refreshAssignments, refreshIfStale, showAssignment, startAssignment, submitAssignment, useAssignments, type AssignmentSummary } from "./assignments";
import { projectsSupported, signIn, useProjects } from "./service";
import { startQuizPractical } from "./matching";
import type { LinkableActivity, PracticalQuestion } from "./types";
import { openAssignmentInTaskMentor, openTaskMentorPage } from "./commands";
import { keyOf, openGrading } from "../grading/service";

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
  // The same colours as project statuses: in progress grey, submitted blue, graded green.
  if (s === "submitted") return <span className="tm-chip tm-status-chip is-submitted">Submitted</span>;
  if (s === "in_progress") return <span className="tm-chip tm-status-chip is-draft">In progress</span>;
  return null;
}

function AssignmentRow({ a, teaching }: { a: AssignmentSummary; teaching?: boolean }) {
  const busy = useAssignments((s) => s.busy[a.id]);
  useProjects((s) => s.binding);
  const due = dueLabel(a.due_date);
  const open = !teaching && isOpenWorkspaceOf(a);
  // Its brief is the front tab of a group (on screen): selected, as the Explorer shows the open file.
  const viewing = useWorkbench((s) =>
    s.groups.some((g) => {
      const e = g.editors.find((x) => x.id === g.activeId);
      return e?.kind === "assignment" && e.assignmentId === a.id;
    }),
  );
  const started = !!a.my?.project_id;
  return (
    <div
      className={`tm-list-row tm-assignment-row ${open ? "is-current" : ""} ${viewing ? "is-viewing" : ""}`}
      aria-current={open ? "true" : undefined}
      aria-selected={viewing}
      role="button"
      tabIndex={0}
      data-testid="assignment-row"
      data-assignment-id={a.id}
      title={`${a.title}\n${a.course_name ?? ""}${a.due_date ? ` · due ${new Date(a.due_date).toLocaleString()}` : ""}`}
      onClick={() => showAssignment(a.id)}
      // Double-click (as on a file) or Enter: the brief, and straight into the work (Start / Open).
      onDoubleClick={() => !teaching && !open && (!a.read_only || started) && void startAssignment(a.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        showAssignment(a.id);
        if (!teaching && !open && (!a.read_only || started)) void startAssignment(a.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { kind: "item", label: "Show Brief", run: () => showAssignment(a.id) },
          ...(!teaching && (started || !a.read_only) ? [{ kind: "item" as const, label: started ? "Continue in TMCode" : "Start", run: () => void startAssignment(a.id) }] : []),
          ...(!teaching && started && !a.read_only ? [{ kind: "item" as const, label: "Submit…", run: () => void submitAssignment(a.id) }] : []),
          ...(teaching ? [{ kind: "item" as const, label: "Grade Submissions", run: () => openGrading(keyOf("assignment", a.id, null)) }] : []),
          { kind: "separator" },
          { kind: "item", label: "Open in Task Mentor", run: () => openAssignmentInTaskMentor(a.id) },
        ]);
      }}
    >
      <Codicon name={a.kind === "case_study" ? "book" : "beaker"} className="tm-project-kind" />
      <span className="tm-assignment-text">
        <span className="tm-project-name">{a.title}</span>
        <span className="tm-assignment-sub">
          {!teaching && <StateChip a={a} />}
          {a.course_name && <span className="tm-assignment-course">{a.course_name}</span>}
          {teaching && (a.status as string) === "draft" ? (
            <span className="tm-due is-soon" title="Publish it in Task Mentor so students can start it">
              Draft · students can't see it
            </span>
          ) : teaching && a.teaching ? (
            <span>
              {a.teaching.submitted}/{a.teaching.students} submitted
            </span>
          ) : (
            due && !a.read_only && a.my?.state !== "graded" && a.my?.state !== "submitted" && <span className={`tm-due is-${due.tone}`}>{due.text}</span>
          )}
        </span>
      </span>
      {open && (
        <span className="tm-open-here" title="Your work for this assignment is the folder open in this window">
          <Codicon name="folder-opened" /> Open here
        </span>
      )}
      {!teaching && !open && (started || !a.read_only) && (
        <button
          type="button"
          className={`tm-button tm-button--small ${started ? "tm-button--secondary" : ""}`}
          disabled={!!busy}
          title={started ? "Open your project for this assignment in this window" : "Create your project (with your teacher's starter files) and open it here"}
          onClick={(e) => {
            e.stopPropagation();
            void startAssignment(a.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {busy === "starting" ? (started ? "Opening…" : "Starting…") : started ? "Open" : "Start"}
        </button>
      )}
    </div>
  );
}

/** A TMCode practical question of a quiz: Start creates (or reopens) the student's workspace from its starter files. */
function QuizPracticalRow({ quiz, q }: { quiz: LinkableActivity; q: PracticalQuestion }) {
  const [busy, setBusy] = useState(false);
  const due = dueLabel(quiz.due_date ?? null);
  const start = async () => {
    setBusy(true);
    try {
      await startQuizPractical(quiz, q);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tm-list-row tm-assignment-row" data-testid="quiz-practical-row" title={`${q.title}\n${quiz.title}${quiz.course_name ? ` · ${quiz.course_name}` : ""}`}>
      <Codicon name="beaker" className="tm-project-kind" />
      <span className="tm-assignment-text">
        <span className="tm-project-name">{q.title}</span>
        <span className="tm-assignment-sub">
          <span className="tm-assignment-course">
            {quiz.title} · {q.points} pt{q.points === 1 ? "" : "s"}
          </span>
          {due && <span className={`tm-due is-${due.tone}`}>{due.text}</span>}
        </span>
      </span>
      <button type="button" className="tm-button tm-button--small" disabled={busy} onClick={() => void start()}>
        {busy ? "Opening…" : "Start"}
      </button>
    </div>
  );
}

const checkedAgo = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** The Assignments view: TMCode practicals and case studies from Task Mentor. */
export function AssignmentsView() {
  const account = useProjects((s) => s.account);
  const student = useAssignments((s) => s.student);
  const teaching = useAssignments((s) => s.teaching);
  const quizPracticals = useAssignments((s) => s.quizPracticals);
  const loading = useAssignments((s) => s.loading);
  const error = useAssignments((s) => s.error);
  const staff = useAssignments((s) => s.staff);
  const checkedAt = useAssignments((s) => s.checkedAt);
  const workspace = useWorkbench((s) => s.workspace);
  const [filter, setFilter] = useState("");

  // Opening the view shows what Task Mentor has now (a teacher may have just published one).
  useEffect(() => {
    if (account?.signed_in) void refreshIfStale(student === null ? 0 : 15_000);
  }, [account?.signed_in]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const quizzes = (quizPracticals ?? []).filter((q) => !filter || `${q.title} ${q.course_name ?? ""} ${(q.practical_questions ?? []).map((p) => p.title).join(" ")}`.toLowerCase().includes(filter.toLowerCase()));
  const practicalCount = quizzes.reduce((n, q) => n + (q.practical_questions?.length ?? 0), 0);
  const nothing = student !== null && student.length === 0 && teach.length === 0 && practicalCount === 0;

  return (
    <div className="tm-projects-view" data-testid="assignments-view">
      <div className="tm-assignments-toolbar">
        <div className="tm-input-box tm-assignments-filter">
          <input className="tm-input" placeholder="Filter assignments" aria-label="Filter assignments" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <ActionButton icon="refresh" label="Refresh from Task Mentor" onClick={() => void refreshAssignments()} className={loading ? "is-busy" : ""} data-testid="assignments-refresh" />
      </div>
      {checkedAt && (
        <p className="tm-assignments-checked" data-testid="assignments-checked">
          {loading ? "Checking Task Mentor…" : `Checked ${checkedAgo(checkedAt)}`}
        </p>
      )}
      {error && <p className="tm-error-text">{error}</p>}
      {student === null && !error ? (
        <SkeletonRows rows={4} label="Loading assignments" />
      ) : nothing ? (
        <div className="tm-view-empty tm-assignments-empty" data-testid="assignments-empty">
          <Codicon name="mortar-board" className="tm-projects-hero" />
          {staff ? (
            <>
              <h3>No TMCode assignments in your subjects yet</h3>
              <p>
                In Task Mentor, create an assignment and choose <b>TMCode</b> as the way students hand it in. Once it's published, it appears here with each student's progress, and you grade it in TMCode.
              </p>
              <div className="tm-assignments-empty-actions">
                <button type="button" className="tm-button" onClick={() => openTaskMentorPage("/assignments/create")} data-testid="assignments-create">
                  <Codicon name="add" /> Create in Task Mentor
                </button>
                <button type="button" className="tm-button tm-button--secondary" disabled={loading} onClick={() => void refreshAssignments()}>
                  <Codicon name="refresh" className={loading ? "codicon-modifier-spin" : ""} /> Refresh
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>Nothing to do in TMCode yet</h3>
              <p>When a teacher publishes an assignment you hand in with TMCode, it appears here with a Start button and your teacher's starter files.</p>
              <div className="tm-assignments-empty-actions">
                <button type="button" className="tm-button" disabled={loading} onClick={() => void refreshAssignments()}>
                  <Codicon name="refresh" className={loading ? "codicon-modifier-spin" : ""} /> Refresh
                </button>
                <button type="button" className="tm-button tm-button--secondary" onClick={() => openTaskMentorPage("/assignments")}>
                  <Codicon name="link-external" /> Open Task Mentor
                </button>
              </div>
            </>
          )}
          {account?.user?.name && <p className="tm-muted tm-assignments-who">Signed in as {account.user.name}</p>}
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
          {practicalCount > 0 && (
            <Section title="Quiz Practicals" count={practicalCount}>
              {quizzes.flatMap((quiz) => (quiz.practical_questions ?? []).map((q) => <QuizPracticalRow key={`${quiz.activity_id}:${q.question_id}`} quiz={quiz} q={q} />))}
            </Section>
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
