import { useEffect, useRef, useState, type ReactNode } from "react";
import { notify, openContextMenu, revealView, useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows } from "../widgets/Skeleton";
import { acceptsSubmissions, dueLabel, groupAssignments, handedInLate, isOpenWorkspaceOf, refreshAssignments, refreshIfStale, returnedForChanges, showAssignment, startAssignment, submitAssignment, useAssignments, type AssignmentSummary } from "./assignments";
import { projectsSupported, refreshProjects, signIn, useProjects } from "./service";
import { startQuizPractical } from "./matching";
import type { LinkableActivity, PracticalQuestion } from "./types";
import { openAssignmentInTaskMentor, openTaskMentorPage } from "./commands";
import { keyOf, openGrading } from "../grading/service";
import { ThisFolder } from "./ProjectsView";
import { useRowNav } from "./rowNav";
import { SignInWaiting } from "./SignInWaiting";
import { isAssessmentWorkspace, opensLabel, practicalStateOf, useSessionEnded, type PracticalState } from "./studentHome";

function Section({ title, count, children, defaultOpen = true, actions, testId }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`tm-pane tm-projects-section ${open ? "is-open" : "is-collapsed"}`} aria-label={title} data-testid={testId}>
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

const gradeText = (grade: number | null | undefined, max: number | null | undefined) => `${grade ?? "–"}/${max ?? "–"}`;

function StateChip({ a }: { a: AssignmentSummary }) {
  if (a.read_only) {
    // Completed: the grade first (when there is one), then the lock.
    return (
      <>
        {a.my?.state === "graded" && (
          <span className="tm-chip is-success" data-testid="assignment-grade-chip">
            {gradeText(a.my.grade, a.my.max_points ?? a.points)}
          </span>
        )}
        <span className="tm-chip tm-chip--locked" data-testid="assignment-locked-chip" title="Completed: you can open your work, but not change or submit it">
          <Codicon name="lock" /> Read-only
        </span>
      </>
    );
  }
  const s = a.my?.state ?? "not_started";
  // Handed in after the due date (the submission's own flag, not "the due date has passed").
  const late = (s === "submitted" || s === "graded") && handedInLate(a) && (
    <span className="tm-chip is-late" data-testid="assignment-late-chip">
      Late
    </span>
  );
  if (s === "graded")
    return (
      <>
        <span className="tm-chip is-success" data-testid="assignment-grade-chip">
          {gradeText(a.my?.grade, a.my?.max_points ?? a.points)}
        </span>
        {late}
      </>
    );
  // The same colours as project statuses: in progress grey, submitted blue, graded green; returned needs attention (orange).
  if (s === "submitted")
    return (
      <>
        <span className="tm-chip tm-status-chip is-submitted">Submitted</span>
        {late}
      </>
    );
  // The teacher closed it before it was handed in: no more submissions.
  if (!acceptsSubmissions(a))
    return (
      <span className="tm-chip tm-chip--locked" data-testid="assignment-closed-chip" title="Your teacher closed this assignment: it no longer accepts work">
        <Codicon name="lock" /> Closed
      </span>
    );
  if (returnedForChanges(a)) {
    return (
      <span className="tm-chip is-warning" data-testid="assignment-returned-chip" title={`Returned by your teacher${a.my?.returned_message ? `: ${a.my.returned_message}` : ""}`}>
        Returned
      </span>
    );
  }
  if (s === "in_progress") return <span className="tm-chip tm-status-chip is-draft">In progress</span>;
  return null;
}

/** The front tab of a group (on screen) is this assignment's brief: selected, as the Explorer shows the open file. */
const useViewingBrief = (id: number) =>
  useWorkbench((s) =>
    s.groups.some((g) => {
      const e = g.editors.find((x) => x.id === g.activeId);
      return e?.kind === "assignment" && e.assignmentId === id;
    }),
  );

function AssignmentRow({ a, teaching, urgent }: { a: AssignmentSummary; teaching?: boolean; urgent?: boolean }) {
  const busy = useAssignments((s) => s.busy[a.id]);
  useProjects((s) => s.binding);
  const due = dueLabel(a.due_date);
  const open = !teaching && isOpenWorkspaceOf(a);
  const viewing = useViewingBrief(a.id);
  const started = !!a.my?.project_id;
  const canWork = !teaching && !open && (!a.read_only || started);
  return (
    <div
      className={`tm-list-row tm-assignment-row ${open ? "is-current" : ""} ${viewing ? "is-viewing" : ""} ${urgent ? "is-urgent" : ""}`}
      aria-current={open ? "true" : undefined}
      aria-selected={viewing}
      role="button"
      tabIndex={-1}
      data-row-nav
      data-testid="assignment-row"
      data-assignment-id={a.id}
      title={`${a.title}\n${a.course_name ?? ""}${a.due_date ? ` · due ${new Date(a.due_date).toLocaleString()}` : ""}`}
      onClick={() => showAssignment(a.id)}
      // Double-click (as on a file) or Enter: the brief, and straight into the work (Start / Open).
      onDoubleClick={() => canWork && void startAssignment(a.id)}
      onKeyDown={(e) => {
        // Keys on the row's own button are the button's.
        if (e.target !== e.currentTarget) return;
        if (e.key === " ") {
          // Space: the brief only (as Space previews a file in the Explorer).
          e.preventDefault();
          showAssignment(a.id);
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        showAssignment(a.id);
        if (canWork) void startAssignment(a.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { kind: "item", label: "Show Brief", run: () => showAssignment(a.id) },
          ...(!teaching && (started || !a.read_only) ? [{ kind: "item" as const, label: started ? "Continue in TMCode" : "Start", run: () => void startAssignment(a.id) }] : []),
          ...(!teaching && started && acceptsSubmissions(a) ? [{ kind: "item" as const, label: "Submit…", run: () => void submitAssignment(a.id) }] : []),
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
      {canWork && (
        // Quiet in the list (shown on hover, focus or selection), as VS Code's row actions; the most urgent to-do keeps a solid Start.
        <button
          type="button"
          className={`tm-button tm-button--small tm-row-action ${urgent ? "" : "tm-button--secondary"}`}
          disabled={!!busy}
          tabIndex={-1}
          data-testid="assignment-row-action"
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

const PRACTICAL_CHIP: Record<PracticalState, string> = { not_started: "", in_progress: "is-draft", submitted: "is-submitted", graded: "is-graded" };

/** A TMCode practical question of a quiz: Start creates (or reopens) the student's workspace from its starter files. */
function QuizPracticalRow({ quiz, q }: { quiz: LinkableActivity; q: PracticalQuestion }) {
  const [busy, setBusy] = useState(false);
  const mine = useProjects((s) => s.mine);
  const binding = useProjects((s) => s.binding);
  const current = useProjects((s) => s.current);
  const found = practicalStateOf(quiz.activity_id, q.question_id, mine, binding ? current : null);
  // The payload's word wins when Task Mentor sends one.
  const state: PracticalState = q.state ?? found.state;
  const here = !!binding && !!found.project && binding.project_id === found.project.id;
  const due = state === "submitted" || state === "graded" ? null : dueLabel(quiz.due_date ?? null);
  const opensAt = quiz.start_date ? Date.parse(quiz.start_date) : NaN;
  const notYet = Number.isFinite(opensAt) && opensAt > Date.now();
  const opens = notYet ? `Opens ${opensLabel(opensAt)}` : null;
  const start = async () => {
    if (busy) return;
    if (notYet) return notify("info", `"${quiz.title}" opens ${opensLabel(opensAt)}. Its practical starts then.`);
    setBusy(true);
    try {
      await startQuizPractical(quiz, q);
    } finally {
      setBusy(false);
    }
  };
  const label = state === "graded" ? (q.grade != null ? `${q.grade}/${q.points}` : "Graded") : STATE_LABEL[state];
  return (
    // Its task is in the quiz (there is no brief tab): the row opens the workspace, as a project row does.
    <div
      className={`tm-list-row tm-assignment-row ${here ? "is-current" : ""}`}
      data-testid="quiz-practical-row"
      data-state={state}
      role="button"
      tabIndex={-1}
      data-row-nav
      aria-busy={busy || undefined}
      aria-disabled={notYet || undefined}
      title={`${q.title}\n${quiz.title}${quiz.course_name ? ` · ${quiz.course_name}` : ""}\n${opens ?? "Open its workspace (keep the quiz open in Task Mentor)"}`}
      onClick={() => void start()}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void start();
        }
      }}
    >
      <Codicon name="beaker" className="tm-project-kind" />
      <span className="tm-assignment-text">
        <span className="tm-project-name">{q.title}</span>
        <span className="tm-assignment-sub">
          <span className={`tm-chip tm-status-chip ${state === "graded" ? "is-success" : PRACTICAL_CHIP[state]}`} data-testid="quiz-practical-state">
            {label}
          </span>
          <span className="tm-assignment-course">
            {quiz.title} · {q.points} pt{q.points === 1 ? "" : "s"}
          </span>
          {opens ? (
            <span className="tm-due is-ok" data-testid="quiz-practical-opens">
              {opens}
            </span>
          ) : (
            due && <span className={`tm-due is-${due.tone}`}>{due.text}</span>
          )}
          {!opens && quiz.attempt_open !== undefined && (state === "not_started" || state === "in_progress") && (
            <span className={`tm-chip ${quiz.attempt_open ? "is-info" : "is-warning"}`} data-testid="quiz-practical-attempt" title={quiz.attempt_open ? "Your quiz attempt is open: you can submit" : "Open the quiz in Task Mentor before you submit"}>
              {quiz.attempt_open ? "Quiz open in Task Mentor" : "Quiz not open in Task Mentor"}
            </span>
          )}
        </span>
      </span>
      {here && (
        <span className="tm-open-here" title="Your work for this practical is the folder open in this window">
          <Codicon name="folder-opened" /> Open here
        </span>
      )}
      {!here && (
        <button
          type="button"
          className="tm-button tm-button--small tm-button--secondary tm-row-action"
          disabled={busy || notYet}
          tabIndex={-1}
          title={opens ? `${opens}: it can't be started yet` : state === "not_started" ? "Create your workspace from the starter files" : "Open your work for this practical"}
          onClick={(e) => {
            e.stopPropagation();
            void start();
          }}
        >
          {busy ? "Opening…" : state === "not_started" ? "Start" : "Open"}
        </button>
      )}
    </div>
  );
}

const checkedAgo = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** Sticky at the top: the NGA session ended (expired, or signed out elsewhere). */
function SessionEndedBanner() {
  return (
    <div className="tm-session-banner" role="alert" data-testid="session-ended-banner">
      <Codicon name="warning" />
      <span>Your NGA session ended. Sign in to keep saving.</span>
      <button type="button" className="tm-button tm-button--small" onClick={() => void signIn()} data-testid="session-ended-signin">
        Sign In
      </button>
    </div>
  );
}

/** The Assignments view: TMCode practicals and case studies from Task Mentor. The student's home. */
export function AssignmentsView() {
  const account = useProjects((s) => s.account);
  const student = useAssignments((s) => s.student);
  const teaching = useAssignments((s) => s.teaching);
  const quizPracticals = useAssignments((s) => s.quizPracticals);
  const loading = useAssignments((s) => s.loading);
  const error = useAssignments((s) => s.error);
  const errorKind = useAssignments((s) => s.errorKind);
  const staff = useAssignments((s) => s.staff);
  const checkedAt = useAssignments((s) => s.checkedAt);
  const binding = useProjects((s) => s.binding);
  const current = useProjects((s) => s.current);
  const mine = useProjects((s) => s.mine);
  const ended = useSessionEnded();
  const workspace = useWorkbench((s) => s.workspace);
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const nav = useRowNav(root);

  // Opening the view shows what Task Mentor has now (a teacher may have just published one).
  useEffect(() => {
    if (account?.signed_in) void refreshIfStale(student === null ? 0 : 15_000);
  }, [account?.signed_in]); // eslint-disable-line react-hooks/exhaustive-deps
  // Quiz practical rows read their state from the student's projects.
  useEffect(() => {
    if (account?.signed_in && mine === null && (quizPracticals?.length ?? 0) > 0) void refreshProjects();
  }, [account?.signed_in, mine, quizPracticals]);
  // Due countdowns stay current while the view is open.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  void workspace;

  if (!projectsSupported()) return <div className="tm-view-empty">Assignments are available in the TMCode desktop app, outside exams.</div>;
  if (!account?.signed_in) {
    const signInBusy = account?.phase === "waiting" || account?.phase === "completing";
    return (
      <div className="tm-projects-view" data-testid="assignments-signed-out">
        {ended && <SessionEndedBanner />}
        <div className="tm-view-empty tm-projects-signin" data-testid="assignments-signin">
          <Codicon name="mortar-board" className="tm-projects-hero" />
          <h3>Practicals and case studies</h3>
          <p>Sign in with your NGA account to see the coding assignments of your subjects, start them with your teacher's starter files, and submit from here.</p>
          <button type="button" className="tm-button tm-button--block" disabled={signInBusy} onClick={() => void signIn()}>
            <Codicon name={signInBusy ? "loading" : "account"} className={signInBusy ? "codicon-modifier-spin" : ""} /> {signInBusy ? "Continue in your browser…" : "Sign in with NGA"}
          </button>
          <SignInWaiting />
        </div>
      </div>
    );
  }
  const match = (a: AssignmentSummary) => !filter || `${a.title} ${a.course_name ?? ""} ${a.language ?? ""}`.toLowerCase().includes(filter.toLowerCase());
  const groups = groupAssignments((student ?? []).filter(match));
  // The one to do first: soonest due, not started yet. Its Start stays solid and visible.
  const urgentId = groups.todo.find((a) => !a.my?.project_id && !a.read_only)?.id ?? null;
  const rows = (list: AssignmentSummary[], empty: string, t?: boolean) =>
    list.length === 0 ? <p className="tm-muted tm-projects-hint">{empty}</p> : list.map((a) => <AssignmentRow key={a.id} a={a} teaching={t} urgent={!t && a.id === urgentId} />);
  const teach = (teaching ?? []).filter(match);
  const quizzes = (quizPracticals ?? []).filter((q) => !filter || `${q.title} ${q.course_name ?? ""} ${(q.practical_questions ?? []).map((p) => p.title).join(" ")}`.toLowerCase().includes(filter.toLowerCase()));
  const practicalCount = quizzes.reduce((n, q) => n + (q.practical_questions?.length ?? 0), 0);
  // A failed check is never "nothing to do": Task Mentor just couldn't say.
  const nothing = !error && student !== null && student.length === 0 && teach.length === 0 && practicalCount === 0;
  // Students: the open assignment workspace (sync, Save, status, Submit) sits on top. One place for the work.
  const thisFolder = staff !== true && isAssessmentWorkspace(current, !!binding);

  return (
    <div className="tm-projects-view" data-testid="assignments-view" ref={root} onKeyDown={nav.onKeyDown} onFocus={nav.onFocus}>
      {ended && <SessionEndedBanner />}
      {thisFolder && (
        <Section title="This Folder" testId="assignments-this-folder">
          <ThisFolder />
        </Section>
      )}
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
      {error && errorKind === "scope" ? (
        <div className="tm-view-empty tm-assignments-empty tm-assignments-error" role="alert" data-testid="assignments-error">
          <Codicon name="error" className="tm-projects-hero" />
          <h3>Couldn't check your subjects in Task Mentor.</h3>
          <p>
            {error}
            {(student?.length ?? 0) + teach.length + practicalCount > 0 ? " The list below may be incomplete." : ""}
          </p>
          <div className="tm-assignments-empty-actions">
            <button type="button" className="tm-button" disabled={loading} onClick={() => void refreshAssignments()} data-testid="assignments-retry">
              <Codicon name="refresh" className={loading ? "codicon-modifier-spin" : ""} /> Retry
            </button>
            <button type="button" className="tm-button tm-button--secondary" onClick={() => void signIn()}>
              <Codicon name="account" /> Sign in again
            </button>
          </div>
        </div>
      ) : (
        error && <p className="tm-error-text">{error}</p>
      )}
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

/** "Show All My Projects" (the Assignments "…" menu). */
export const showAllMyProjects = () => revealView("projects");
