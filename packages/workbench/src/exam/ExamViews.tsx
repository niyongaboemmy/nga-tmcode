import { useEffect, useMemo, useState } from "react";
import { executeCommand } from "../commands/registry";
import { Codicon } from "../widgets/icons";
import { Logo } from "../widgets/Logo";
import { renderBrief } from "../widgets/markdown";
import { examClock, focusTask, stopExam, submitExam } from "./session";
import { formatRemaining } from "./clock";
import { useExam } from "./state";

/** Re-renders every second while mounted (countdowns). */
function useNow(active: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return examClock().now();
}

export function Countdown({ compact = false }: { compact?: boolean }) {
  const deadline = useExam((s) => s.deadline);
  const phase = useExam((s) => s.phase);
  const now = useNow(phase === "active");
  if (!deadline) return null;
  const left = deadline - now;
  const level = left <= 60_000 ? "critical" : left <= 5 * 60_000 ? "warning" : "normal";
  return (
    <span className={`tm-countdown is-${level}`} role="timer" aria-live={level === "normal" ? "off" : "polite"} title={`Ends at ${new Date(deadline).toLocaleTimeString()}`}>
      <Codicon name="watch" />
      {compact ? formatRemaining(left) : `${formatRemaining(left)} left`}
    </span>
  );
}

/** Title-bar centre while in an exam: quiz name, time left, Submit. */
export function ExamTitle() {
  const quiz = useExam((s) => s.quiz);
  const phase = useExam((s) => s.phase);
  if (!quiz) return null;
  return (
    <div className="tm-exam-title">
      <Codicon name="mortar-board" />
      <span className="tm-exam-title-name">{quiz.title}</span>
      {phase === "active" && <Countdown compact />}
      {(phase === "active" || phase === "locked") && (
        <button type="button" className="tm-button tm-exam-submit" onClick={() => void submitExam()} data-testid="exam-submit">
          <Codicon name="send" /> Submit
        </button>
      )}
    </div>
  );
}

export function SyncStatus() {
  const sync = useExam((s) => s.sync);
  const phase = useExam((s) => s.phase);
  if (phase === "idle" || phase === "error" || phase === "starting") return null;
  const label = sync.tampered
    ? "Saving failed — tell your teacher"
    : sync.offline
      ? `Offline — ${sync.pending} change${sync.pending === 1 ? "" : "s"} saved on this computer`
      : sync.pending || sync.queued
        ? "Saving to Task Mentor…"
        : "All work saved";
  const busy = sync.pending > 0 || sync.queued > 0;
  const icon = sync.tampered ? "error" : sync.offline ? "cloud-offline" : busy ? "sync" : "cloud";
  return (
    <span className={`tm-status-item tm-sync ${sync.offline || sync.tampered ? "is-warning" : ""}`} title={label} data-testid="exam-sync">
      <Codicon name={icon} className={busy && !sync.offline ? "codicon-modifier-spin" : ""} />
      {label}
    </span>
  );
}

/** Side-bar view: tasks, time, and the active task's brief. */
export function TaskView() {
  const { quiz, tasks, activeTask, phase, message } = useExam();
  const task = tasks.find((t) => t.question_id === activeTask) ?? tasks[0];
  const brief = useMemo(() => (task ? renderBrief(task.brief_md) : ""), [task]);
  if (!quiz) {
    return (
      <div className="tm-view-empty">
        <p>No exam is open.</p>
        <p className="tm-muted">Start a coding test or exam from Task Mentor and choose <strong>Open in TMCode</strong>.</p>
      </div>
    );
  }
  const total = tasks.reduce((n, t) => n + t.points, 0);
  return (
    <div className="tm-pane tm-taskview">
      <div className="tm-taskview-head">
        <div className="tm-taskview-quiz">{quiz.title}</div>
        <div className="tm-taskview-meta">
          <Countdown />
          <span className="tm-muted">
            {tasks.length} task{tasks.length > 1 ? "s" : ""} · {total} pts
          </span>
        </div>
        {message && <div className="tm-taskview-message">{message}</div>}
      </div>
      <div className="tm-taskview-tasks" role="tablist" aria-label="Tasks">
        {tasks.map((t) => (
          <button
            key={t.question_id}
            type="button"
            role="tab"
            aria-selected={t.question_id === task?.question_id}
            className={`tm-taskview-task ${t.question_id === task?.question_id ? "is-active" : ""}`}
            onClick={() => focusTask(t.question_id)}
          >
            <span className="tm-taskview-num">{t.order}</span>
            <span className="tm-taskview-name">{t.title}</span>
            <span className="tm-taskview-pts">{t.points} pts</span>
            {t.last_seq > 0 && <Codicon name="check" className="tm-taskview-saved" title="Saved" />}
          </button>
        ))}
      </div>
      {task && (
        <div className="tm-pane-body tm-scroll tm-taskview-brief">
          <article className="tm-md" dangerouslySetInnerHTML={{ __html: brief }} />
          <div className="tm-taskview-tests">
            <Codicon name="beaker" />
            <span>
              {task.visible_tests.length} example test{task.visible_tests.length === 1 ? "" : "s"} you can run
              {task.hidden_test_count > 0 && <> · {task.hidden_test_count} hidden test{task.hidden_test_count === 1 ? "" : "s"} graded by Task Mentor</>}
            </span>
            {task.visible_tests.length > 0 && phase === "active" && (
              <button type="button" className="tm-link-button" onClick={() => executeCommand("tmcode.runTests")}>
                Run them
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Full-window states around an exam: opening, failed to open, submitted. */
export function ExamOverlay() {
  const { phase, error, results, quiz, message, tasks } = useExam();
  if (phase === "starting") {
    return (
      <div className="tm-exam-overlay" role="status" aria-live="polite">
        <div className="tm-exam-card">
          <Logo size={56} />
          <h2>Opening your exam…</h2>
          <p className="tm-muted">Downloading your tasks from Task Mentor.</p>
          <div className="tm-progress" />
        </div>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="tm-exam-overlay" role="alert">
        <div className="tm-exam-card">
          <Codicon name="error" className="tm-exam-card-icon is-error" />
          <h2>The exam could not be opened</h2>
          <p>{error}</p>
          <button type="button" className="tm-button" onClick={() => stopExam()}>
            Close
          </button>
        </div>
      </div>
    );
  }
  if (phase === "submitting") {
    return (
      <div className="tm-exam-overlay" role="status" aria-live="polite">
        <div className="tm-exam-card">
          <Codicon name="sync" className="tm-exam-card-icon codicon-modifier-spin" />
          <h2>Submitting…</h2>
          <p className="tm-muted">{message ?? "Sending your final code to Task Mentor."}</p>
        </div>
      </div>
    );
  }
  if (phase === "submitted") {
    const released = results?.status === "released";
    return (
      <div className="tm-exam-overlay" role="status">
        <div className="tm-exam-card tm-exam-results">
          <Codicon name="pass-filled" className="tm-exam-card-icon is-ok" />
          <h2>Submitted</h2>
          <p>{quiz?.title} was submitted to Task Mentor.</p>
          {!results || results.status === "grading" ? (
            <p className="tm-muted">
              <Codicon name="loading" className="codicon-modifier-spin" /> Grading your code…
            </p>
          ) : !released ? (
            <p className="tm-muted">Your teacher will release the results in Task Mentor.</p>
          ) : (
            <>
              <div className="tm-exam-score">
                <strong>{results.score}</strong> / {results.max_score}
              </div>
              <ul className="tm-exam-qresults">
                {results.questions?.map((q, i) => {
                  // Name each result as the student saw it: "1. Sum of two numbers", not the question id.
                  const at = tasks.findIndex((t) => t.question_id === q.question_id);
                  return (
                  <li key={q.question_id}>
                    <span>{at >= 0 ? `${at + 1}. ${tasks[at].title}` : `Task ${i + 1}`}</span>
                    <span>
                      {q.points}/{q.max_points}
                    </span>
                    <span className="tm-muted">
                      {q.tests.filter((t) => t.passed).length}/{q.tests.length} tests passed
                    </span>
                  </li>
                  );
                })}
              </ul>
            </>
          )}
          <button type="button" className="tm-button tm-button--secondary" onClick={() => stopExam()}>
            Close exam
          </button>
        </div>
      </div>
    );
  }
  return null;
}
