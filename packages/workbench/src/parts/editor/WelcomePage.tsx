import { executeCommand, formatKeybinding, getCommand, keybindingFor } from "../../commands/registry";
import { useEffect, useState, type ReactNode } from "react";
import { getPlatform, openRecent, revealView, useWorkbench } from "../../state/store";
import { dueLabel, isOpenWorkspaceOf, refreshAssignments, showAssignment, startAssignment, useAssignments, type AssignmentSummary } from "../../projects/assignments";
import { showAssignmentsGroup, type AssignmentGroup } from "../../projects/AssignmentsView";
import { openInTaskMentor } from "../../projects/taskMentorLinks";
import { projectsSupported, signIn, useProjects } from "../../projects/service";
import { SignInWaiting } from "../../projects/SignInWaiting";
import { deriveStatus } from "../../projects/status";
import { homeCounts, nextUp, nextUpReason, studentTasks } from "../../projects/studentHome";
import { gradingQueue, openGrading, startGrading, useGrading } from "../../grading/service";
import { isTeacherRole, useRole, useRoleChecking } from "../../state/role";
import { markJourney } from "../../util/journey";
import { Codicon } from "../../widgets/icons";
import { Logo } from "../../widgets/Logo";
import { SkeletonLines } from "../../widgets/Skeleton";

/**
 * Home (workflow plan §3.5, W1/W2): VS Code's Welcome page, evolved into the
 * one starting point. It opens on every start in practice mode
 * (workbench.startupEditor) and shows ONE obvious next step for the person
 * using it: a student's next assignment, or a teacher's submissions to grade.
 * It reads only what TMCode already loads (assignments, grading counts, Recent).
 */

const RELEASE_NOTES_URL = "https://github.com/niyongaboemmy/nga-tmcode/releases";

function openExternal(url: string) {
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function HomeLink({ icon, label, command, kb, testId }: { icon: string; label: string; command: string; kb?: string; testId?: string }) {
  const os = getPlatform().os;
  // The real binding on this OS (Open Folder is Ctrl+K Ctrl+O on Windows and Linux, not Ctrl+O).
  const cmd = getCommand(command);
  if (kb && cmd) kb = keybindingFor(cmd, os) || kb;
  return (
    <button type="button" className="tm-welcome-link" onClick={() => executeCommand(command)} data-testid={testId}>
      <Codicon name={icon} />
      <span>{label}</span>
      {kb && <span className="tm-welcome-kb">{formatKeybinding(kb, os)}</span>}
    </button>
  );
}

function Card({ testId, children, tone }: { testId: string; children: ReactNode; tone?: "primary" | "quiet" }) {
  return (
    <section className={`tm-home-card ${tone === "quiet" ? "is-quiet" : "is-primary"}`} data-testid={testId}>
      {children}
    </section>
  );
}

// ── Signed out ──────────────────────────────────────────────────────────────

function SignInCard() {
  const account = useProjects((s) => s.account);
  const busy = account?.phase === "waiting" || account?.phase === "completing";
  return (
    <Card testId="home-signin-card">
      <h2 className="tm-home-title">
        <Codicon name="mortar-board" /> Sign in to see your assignments
      </h2>
      <p>Your teachers' work appears here, with one button to start it, and you hand it in from TMCode.</p>
      <div className="tm-home-actions">
        <button type="button" className="tm-button tm-button--large" disabled={busy} onClick={() => void signIn()} data-testid="welcome-signin">
          <Codicon name={busy ? "loading" : "account"} className={busy ? "codicon-modifier-spin" : ""} /> {busy ? "Continue in your browser…" : "Sign in"}
        </button>
      </div>
      <SignInWaiting compact />
    </Card>
  );
}

// ── Students ────────────────────────────────────────────────────────────────

/** "Next up": the one assignment to work on, with its one button. */
function NextUp({ a, openId }: { a: AssignmentSummary; openId: number | null }) {
  const busy = useAssignments((s) => s.busy[a.id]);
  const current = useProjects((s) => s.current);
  useProjects((s) => s.binding);
  const here = isOpenWorkspaceOf(a);
  const view = deriveStatus(a, here ? current : null, { here });
  const due = dueLabel(a.due_date);
  // Home's one door: Start, Continue (into the code and the brief), or the feedback.
  const action = view.status === "not_started" ? "Start" : view.status === "graded" ? "View Feedback" : "Continue";
  const go = () => {
    if (view.status === "graded" || (here && action === "Continue")) return showAssignment(a.id, { toSide: here });
    void startAssignment(a.id);
  };
  return (
    <Card testId="home-next-up">
      <div className="tm-home-kicker">
        <span>Next up</span>
        <span className="tm-home-why" data-testid="home-next-why">
          · {nextUpReason(a, openId)}
        </span>
        {a.course_name && <span>· {a.course_name}</span>}
        {due && (
          <span className={`tm-home-due is-${due.tone}`} title={a.due_date ? new Date(a.due_date).toLocaleString() : undefined}>
            · {due.text}
          </span>
        )}
      </div>
      <h2 className="tm-home-title" data-testid="home-next-title">
        {a.title}
      </h2>
      <p className="tm-home-headline" data-testid="home-next-status" data-status={view.status}>
        {view.syncing ? "Updating…" : view.headline}
      </p>
      {view.status === "returned" && a.my?.returned_message && <q className="tm-home-note">{a.my.returned_message}</q>}
      <div className="tm-home-actions">
        <button type="button" className="tm-button tm-button--large" disabled={!!busy} onClick={go} data-testid="home-next-action">
          <Codicon name={busy === "starting" ? "loading" : action === "Start" ? "play" : action === "View Feedback" ? "pass" : "arrow-right"} className={busy === "starting" ? "codicon-modifier-spin" : ""} />{" "}
          {busy === "starting" ? "Opening…" : action}
        </button>
      </div>
    </Card>
  );
}

function Counter({ group, label, n }: { group: AssignmentGroup; label: string; n: number }) {
  return (
    <button type="button" className={`tm-home-counter ${n ? "" : "is-zero"}`} onClick={() => showAssignmentsGroup(group)} data-testid={`home-count-${group}`}>
      <b>{n}</b> {label}
    </button>
  );
}

function StudentHome() {
  const student = useAssignments((s) => s.student);
  const error = useAssignments((s) => s.error);
  const loading = useAssignments((s) => s.loading);
  const current = useProjects((s) => s.current);
  const binding = useProjects((s) => s.binding);
  const openId = binding && current?.id === binding.project_id ? (current.assignment?.id ?? null) : null;
  const quizzes = useAssignments((s) => s.quizPracticals);
  const mine = useProjects((s) => s.mine);
  if (student === null && !error) {
    return (
      <Card testId="home-loading">
        <p className="tm-muted">Checking Task Mentor…</p>
        <SkeletonLines lines={3} />
      </Card>
    );
  }
  const next = nextUp(student, openId);
  const counts = homeCounts(studentTasks(student, quizzes, mine, current));
  return (
    <>
      {error && (
        <div className="tm-home-error" role="alert" data-testid="home-error">
          <Codicon name="warning" /> <span>{error} The list may be incomplete.</span>
          <button type="button" className="tm-link-button" disabled={loading} onClick={() => void refreshAssignments()}>
            Try Again
          </button>
        </div>
      )}
      {next ? (
        <NextUp a={next} openId={openId} />
      ) : (
        <Card testId="home-nothing" tone="quiet">
          <h2 className="tm-home-title">
            <Codicon name="pass" /> Nothing to do right now
          </h2>
          <p>New work from your teachers appears here as soon as it's published.</p>
        </Card>
      )}
      <div className="tm-home-counters" data-testid="home-counters">
        <Counter group="returned" label="Returned" n={counts.returned} />
        <Counter group="todo" label="To do" n={counts.todo} />
        <Counter group="graded" label="Graded" n={counts.graded} />
      </div>
    </>
  );
}

// ── Teachers ────────────────────────────────────────────────────────────────

const gradingSummary = gradingQueue;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


function TeacherHome() {
  const activities = useGrading((s) => s.activities);
  const rosters = useGrading((s) => s.rosters);
  const loading = useGrading((s) => s.loading);
  const { toGrade, drafts, practicals, rows } = gradingSummary(activities, rosters);
  if (activities === null) {
    return (
      <Card testId="home-loading">
        <p className="tm-muted">Checking what's waiting to be graded…</p>
        <SkeletonLines lines={3} />
      </Card>
    );
  }
  const draftText = drafts ? ` · ${plural(drafts, "draft")} not released` : "";
  return (
    <>
      <Card testId="home-to-grade">
        <div className="tm-home-kicker">
          <span>To grade</span>
        </div>
        <h2 className="tm-home-title" data-testid="home-to-grade-summary">
          {toGrade ? `${plural(toGrade, "submission")} to grade in ${plural(practicals, "activity", "activities")}` : activities.length ? "Nothing waiting to be graded" : "No code assignments or coding questions in your subjects yet"}
          {draftText && <span className="tm-home-title-extra">{draftText}</span>}
        </h2>
        <div className="tm-home-actions">
          {toGrade > 0 || drafts > 0 ? (
            <button type="button" className="tm-button tm-button--large" onClick={() => startGrading()} data-testid="home-start-grading">
              <Codicon name="arrow-right" /> {toGrade ? "Start Grading" : "Review Drafts"}
            </button>
          ) : activities.length ? (
            <button type="button" className="tm-button tm-button--secondary" onClick={() => revealView("grading")} data-testid="home-open-grading">
              <Codicon name="tasklist" /> Open Grading
            </button>
          ) : (
            <button type="button" className="tm-button" onClick={() => openInTaskMentor({ kind: "page", path: "/assignments/create" })} data-testid="home-create">
              <Codicon name="add" /> Create in Task Mentor
            </button>
          )}
          {loading && <Codicon name="loading" className="codicon-modifier-spin tm-muted" />}
        </div>
      </Card>
      {rows.length > 0 && (
        <section className="tm-home-list" aria-label="Practicals" data-testid="home-practicals">
          {rows.slice(0, 6).map(({ a, toGrade: n, drafts: d, submitted }) => (
            <button key={a.key} type="button" className="tm-home-row" onClick={() => openGrading(a.key)} data-testid="home-practical" data-key={a.key}>
              <Codicon name={a.type === "quiz" ? "checklist" : "beaker"} />
              <span className="tm-home-row-title">
                {a.question_title ?? a.title}
                <small>{[a.question_title ? a.title : null, a.course_name].filter(Boolean).join(" · ")}</small>
              </span>
              <span className={`tm-chip ${n ? "is-info" : ""}`}>{n === null ? "…" : n ? `${n} to grade` : d ? `${plural(d, "draft")}` : submitted ? "All graded" : "No submissions yet"}</span>
            </button>
          ))}
        </section>
      )}
      <div className="tm-home-links">
        <button type="button" className="tm-link-button" onClick={() => revealView("assignments")} data-testid="home-class-assignments">
          <Codicon name="mortar-board" /> Your classes' assignments
        </button>
        <button type="button" className="tm-link-button" onClick={() => openInTaskMentor({ kind: "page", path: "/assignments/create" })}>
          <Codicon name="link-external" /> Create in Task Mentor
        </button>
      </div>
    </>
  );
}

// ── What's new (one week after 0.15 arrives, dismissable) ───────────────────

const WHATS_NEW = { key: "tmcode:whats-new", version: "0.15", days: 7 };

function readWhatsNew(): { version: string; firstSeen: number; dismissed?: boolean } | null {
  try {
    return JSON.parse(localStorage.getItem(WHATS_NEW.key) ?? "null");
  } catch {
    return null;
  }
}

function WhatsNew() {
  const [show, setShow] = useState(() => {
    const seen = readWhatsNew();
    if (seen?.version === WHATS_NEW.version) return !seen.dismissed && Date.now() - seen.firstSeen < WHATS_NEW.days * 86_400_000;
    try {
      localStorage.setItem(WHATS_NEW.key, JSON.stringify({ version: WHATS_NEW.version, firstSeen: Date.now() }));
    } catch {
      /* private mode: shown this time */
    }
    return true;
  });
  if (!show) return null;
  return (
    <div className="tm-home-whats-new" role="note" data-testid="home-whats-new">
      <Codicon name="sparkle" />
      <span className="tm-home-whats-new-text">
        <b>New in TMCode {WHATS_NEW.version}:</b> TMCode opens on Home, with your next assignment or what to grade one click away. Every screen has one main button.{" "}
        <button type="button" className="tm-link-button" onClick={() => openExternal(RELEASE_NOTES_URL)}>
          What's new
        </button>
      </span>
      <button
        type="button"
        className="tm-action"
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="home-whats-new-dismiss"
        onClick={() => {
          setShow(false);
          try {
            localStorage.setItem(WHATS_NEW.key, JSON.stringify({ ...(readWhatsNew() ?? { version: WHATS_NEW.version, firstSeen: Date.now() }), dismissed: true }));
          } catch {
            /* ignore */
          }
        }}
      >
        <Codicon name="close" />
      </button>
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export function WelcomePage() {
  const recent = useWorkbench((s) => s.recent);
  const mode = useWorkbench((s) => s.policy.mode);
  const signedIn = useProjects((s) => !!s.account?.signed_in);
  const teacher = useRole((s) => isTeacherRole(s.role));
  const checking = useRoleChecking();
  const grader = useGrading((s) => s.grader);
  const practice = mode === "practice";
  const withAccount = practice && projectsSupported();
  useEffect(() => markJourney("home-shown"), []);

  return (
    <div className="tm-welcome tm-home tm-scroll" data-testid="home-page" data-role={!withAccount || !signedIn ? "none" : checking ? "checking" : teacher || grader ? "teacher" : "student"}>
      <div className="tm-welcome-inner tm-home-inner">
        <header className="tm-welcome-hero tm-home-hero">
          <Logo size={40} className="tm-welcome-logo" />
          <div>
            <h1>Home</h1>
            <p className="tm-welcome-tagline">Write, run and hand in your code, connected to Task Mentor.</p>
          </div>
        </header>

        {withAccount && <WhatsNew />}

        <div className="tm-home-main">
          {withAccount &&
            (!signedIn ? (
              <SignInCard />
            ) : checking ? (
              <Card testId="home-checking">
                <p className="tm-muted" role="status">
                  Checking your classes…
                </p>
                <SkeletonLines lines={3} />
              </Card>
            ) : teacher || grader ? (
              <TeacherHome />
            ) : (
              <StudentHome />
            ))}
        </div>

        <div className="tm-welcome-columns">
          <div className="tm-welcome-col">
            <section data-testid="home-practise">
              <h2>Practise on your own</h2>
              <HomeLink icon="folder-opened" label="Open Folder..." command="workbench.action.files.openFolder" kb="mod+o" />
              <HomeLink icon="new-folder" label="New Project from Starter..." command="workbench.action.newProjectFromTemplate" />
              <HomeLink icon="new-file" label="New File..." command="explorer.newFile" kb="mod+alt+n" />
            </section>
            <section>
              <h2>Recent</h2>
              {recent.length === 0 ? (
                <p className="tm-muted">No recent folders yet. Open a folder to start.</p>
              ) : (
                recent.slice(0, 5).map((r) => (
                  <button key={r.root} type="button" className="tm-welcome-recent" onClick={() => void openRecent(r.root)} title={r.root}>
                    <span className="tm-welcome-recent-name">{r.name}</span>
                    <span className="tm-welcome-recent-path">{r.root}</span>
                  </button>
                ))
              )}
            </section>
          </div>
          <div className="tm-welcome-col">
            <section>
              <h2>Help</h2>
              {practice && <HomeLink icon="tools" label="Check My Computer" command="tmcode.checkMyComputer" testId="welcome-check-computer" />}
              <HomeLink icon="keyboard" label="Keyboard Shortcuts" command="workbench.action.keybindingsReference" />
              <HomeLink icon="symbol-color" label="Choose a Color Theme" command="workbench.action.selectTheme" kb="mod+k mod+t" />
              {practice && (
                <button type="button" className="tm-welcome-link" data-testid="welcome-exam-card" onClick={() => openInTaskMentor({ kind: "page", path: "/quizzes" })} title="Open your quizzes in Task Mentor">
                  <Codicon name="checklist" />
                  <span>Taking an exam? Open it from Task Mentor.</span>
                </button>
              )}
            </section>
          </div>
        </div>
        <footer className="tm-welcome-footer">
          <span className={`tm-mode-pill is-${mode}`}>{practice ? "Practice mode" : "Monitored exam"}</span>
          <span className="tm-muted">New Generation Academy · TMCode {getPlatform().version}</span>
        </footer>
      </div>
    </div>
  );
}
