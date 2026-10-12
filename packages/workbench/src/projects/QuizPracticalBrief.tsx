import { useState } from "react";
import { executeCommand } from "../commands/registry";
import { useWorkbench, type EditorInput } from "../state/store";
import { Codicon } from "../widgets/icons";
import { BriefSyncLine } from "./AssignmentEditor";
import { dueLabel, STUDENT_STATUS_LABEL, useAssignments } from "./assignments";
import { startQuizPractical } from "./matching";
import { findPractical, practicalState, practicalSummary, submitQuizPractical } from "./quizPractical";
import { autoSaveMode, recheck, useProjects } from "./service";
import { deriveStatus } from "./status";
import { StatusSteps } from "./StatusSteps";
import { opensLabel } from "./studentHome";
import { openQuizInTaskMentor } from "./submitFlow";
import { useStatusSync } from "./useStatusSync";

type Input = Extract<EditorInput, { kind: "assignment" }>;

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

/**
 * A quiz practical's brief (workflow plan 6.3, W7): the same one-status card
 * as an assignment's. Its first step is opening the quiz in Task Mentor (a
 * practical is handed in during the student's attempt).
 */
export function QuizPracticalBrief({ input }: { input: Input }) {
  const quizId = input.quizId!;
  const questionId = input.questionId!;
  useAssignments((s) => s.quizPracticals);
  const mine = useProjects((s) => s.mine);
  const binding = useProjects((s) => s.binding);
  const current = useProjects((s) => s.current);
  const sync = useProjects((s) => s.sync);
  const hasFiles = useWorkbench((s) => !s.dirs[""] || s.dirs[""].some((e) => !e.name.startsWith(".")));
  const [busy, setBusy] = useState<null | "starting" | "submitting">(null);
  const ref = findPractical(quizId, questionId);
  const found = ref ? practicalState(ref, mine, binding ? current : null) : null;
  const here = !!found?.project && !!binding && binding.project_id === found.project.id;
  const summary = ref && found ? practicalSummary(ref, found.state, here ? current : found.project) : null;
  const view = useStatusSync(summary ? deriveStatus(summary, here ? current : null, { here }) : null, input.id, () => Promise.all([recheck(), import("./assignments").then((m) => m.refreshAssignments())]));

  if (!ref || !summary || !view) {
    return (
      <div className="tm-assignment-page" data-testid="assignment-page">
        <p className="tm-muted">This quiz practical isn't in your list any more. Refresh Assignments, or open the quiz in Task Mentor.</p>
      </div>
    );
  }
  const { quiz, q } = ref;
  const status = view.status;
  const opensAt = quiz.start_date ? Date.parse(quiz.start_date) : NaN;
  const notYet = Number.isFinite(opensAt) && opensAt > Date.now();
  const handedIn = status === "submitted" || status === "graded";
  const due = handedIn ? null : dueLabel(quiz.due_date ?? null);
  // Until the attempt is open, opening the quiz is the step (Task Mentor refuses the hand-in otherwise).
  const quizFirst = quiz.attempt_open === false && !handedIn && status !== "closed";
  const saving = sync === "saving" || sync === "pulling";
  const start = async () => {
    if (busy) return;
    setBusy("starting");
    try {
      await startQuizPractical(quiz, q);
    } finally {
      setBusy(null);
    }
  };
  const submit = async () => {
    setBusy("submitting");
    try {
      await submitQuizPractical(quizId, questionId);
    } finally {
      setBusy(null);
    }
  };
  const spin = (b: typeof busy, icon: string) => <Codicon name={busy === b ? "loading" : icon} className={busy === b ? "codicon-modifier-spin" : ""} />;
  const quizButton = (
    <button type="button" className={`tm-button ${quizFirst ? "tm-button--large" : "tm-button--secondary"}`} onClick={() => openQuizInTaskMentor(quizId)} data-testid="quiz-open-attempt">
      <Codicon name="link-external" /> Open Quiz
    </button>
  );

  return (
    <div className="tm-assignment-page" data-testid="assignment-page" data-source="quiz">
      <header className="tm-assignment-head">
        <div className="tm-assignment-kicker">
          <Codicon name="checklist" />
          <span>Quiz practical · {quiz.title}</span>
          {quiz.course_name && <span>· {quiz.course_name}</span>}
        </div>
        <h1>{q.title}</h1>
        <div className="tm-assignment-facts">
          <span className="tm-fact tm-fact--state" data-testid="assignment-state" data-status={status}>
            <Codicon name="circle-filled" className={`tm-state-dot is-${status === "closed" ? "readonly" : status}`} />
            {status === "graded" && q.grade != null ? `Graded ${q.grade}/${q.points}` : STUDENT_STATUS_LABEL[status]}
            {view.syncing && <span className="tm-muted"> · Updating…</span>}
          </span>
          {quiz.due_date && (
            <span className={`tm-fact ${due ? `is-${due.tone}` : ""}`}>
              <Codicon name="calendar" /> Due {when(quiz.due_date)}
              {due && <b> · {due.text}</b>}
            </span>
          )}
          <span className="tm-fact">
            <Codicon name="star-empty" /> {q.points} point{q.points === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {status !== "not_started" && status !== "closed" && <StatusSteps status={status} testId="assignment-steps" />}

      <section className={`tm-next-step is-${status === "not_started" ? "start" : status === "graded" ? "graded" : !here ? "open" : status === "submitted" ? "done" : "working"}`} data-testid="assignment-next-step" data-status={status} aria-label="Next step">
        {quizFirst && (
          <div className="tm-next-step-text tm-quiz-step" data-testid="quiz-step">
            <h2>
              <Codicon name="checklist" /> First, open the quiz in Task Mentor
            </h2>
            <p>Your practical is handed in during your quiz attempt. Keep the quiz open while you work here.</p>
          </div>
        )}
        {quizFirst && quizButton}
        {quizFirst && <span className="tm-next-step-break" />}
        {notYet ? (
          <div className="tm-next-step-text">
            <h2>
              <Codicon name="clock" /> Opens {opensLabel(opensAt)}
            </h2>
            <p>The practical starts when the quiz opens.</p>
          </div>
        ) : status === "not_started" ? (
          <>
            <div className="tm-next-step-text">
              <h2>
                <Codicon name="rocket" /> Start this practical
              </h2>
              <p>TMCode creates your own project from the starter files and opens it in this window, with this brief beside your code.</p>
            </div>
            <button type="button" className={`tm-button ${quizFirst ? "tm-button--secondary" : "tm-button--large"}`} disabled={!!busy} onClick={() => void start()} data-testid="assignment-start">
              {spin("starting", "play")} {busy === "starting" ? "Preparing your project…" : "Start"}
            </button>
          </>
        ) : status === "graded" ? (
          <div className="tm-next-step-text" data-testid="assignment-result">
            <h2>
              <Codicon name="pass" /> Graded
            </h2>
            <div className="tm-assignment-grade">
              <b>{q.grade ?? "–"}</b>
              <span>/ {q.points}</span>
            </div>
            <p className="tm-muted">Your teacher's feedback is with the quiz results in Task Mentor.</p>
          </div>
        ) : status === "closed" ? (
          <div className="tm-next-step-text">
            <h2>
              <Codicon name="lock" /> Closed
            </h2>
            <p>The quiz is closed: this practical no longer takes work.</p>
          </div>
        ) : !here ? (
          <>
            <div className="tm-next-step-text">
              <h2>
                <Codicon name={status === "submitted" ? "lock" : "folder-opened"} /> {status === "submitted" ? "Submitted" : "Continue your work"}
              </h2>
              <p>{status === "submitted" ? "Your teacher sees the version you handed in." : "Your project is saved in Task Mentor. Continue opens it in this window, then Submit."}</p>
            </div>
            <button type="button" className={`tm-button ${quizFirst ? "tm-button--secondary" : "tm-button--large"}`} disabled={!!busy} onClick={() => void start()} data-testid="assignment-continue">
              {spin("starting", "folder-opened")} {busy === "starting" ? "Opening…" : "Continue"}
            </button>
          </>
        ) : status === "submitted" ? (
          <>
            <div className="tm-next-step-text">
              <h2>
                <Codicon name="lock" /> Submitted
              </h2>
              <p>Your teacher sees the version you handed in. Withdraw it if you need to change something before it's graded.</p>
            </div>
            <button type="button" className="tm-button tm-button--secondary" onClick={() => executeCommand("projects.withdraw")} data-testid="assignment-withdraw">
              <Codicon name="discard" /> Withdraw to Edit
            </button>
          </>
        ) : (
          <>
            <div className="tm-next-step-text">
              <h2>
                <Codicon name="edit" /> You're working on it in this window
              </h2>
              <p>Your work saves to Task Mentor as you go. Submit hands it in for your quiz attempt.</p>
              <BriefSyncLine />
            </div>
            <div className="tm-next-step-actions">
              {autoSaveMode() === "off" && (
                <button type="button" className="tm-button tm-button--secondary" disabled={saving || !!busy} onClick={() => executeCommand("projects.save")} data-testid="assignment-save" title="Save to Task Mentor">
                  <Codicon name={saving ? "loading" : "cloud-upload"} className={saving ? "codicon-modifier-spin" : ""} /> {saving ? "Saving…" : "Save to Task Mentor"}
                </button>
              )}
              <button type="button" className={`tm-button ${quizFirst ? "tm-button--secondary" : ""}`} disabled={saving || !!busy || view.syncing || !hasFiles} onClick={() => void submit()} data-testid="assignment-submit" title={hasFiles ? undefined : "Create your first file (Explorer), then Submit."}>
                {spin("submitting", "send")} {busy === "submitting" ? "Submitting…" : hasFiles ? "Submit" : "Nothing to hand in yet"}
              </button>
            </div>
          </>
        )}
        <span className="tm-next-step-break" />
        {!quizFirst && (
          <button type="button" className="tm-link-button tm-next-step-tm" onClick={() => openQuizInTaskMentor(quizId)}>
            <Codicon name="link-external" /> Open the Quiz in Task Mentor
          </button>
        )}
      </section>

      <section className="tm-assignment-section">
        <h2>Task</h2>
        <p>
          <b>{q.title}</b>
        </p>
        <p className="tm-muted">The full question is in the quiz in Task Mentor.</p>
      </section>
    </div>
  );
}
