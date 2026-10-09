import { useEffect, useMemo, useState } from "react";
import { executeCommand } from "../commands/registry";
import { Codicon } from "../widgets/icons";
import { Logo } from "../widgets/Logo";
import { renderBrief } from "../widgets/markdown";
import { examClock, focusTask, stopExam, submitExam } from "./session";
import { formatRemaining } from "./clock";
import { useExam, type LockReason } from "./state";
import { useWorkbench } from "../state/store";

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
  const timeUp = useExam((s) => s.timeUp);
  if (!quiz) return null;
  // Submit only while it can work: after time is up the exam submits itself, and a locked session has its own card.
  const open = phase === "active" && !timeUp;
  return (
    <div className="tm-exam-title">
      <Codicon name="mortar-board" />
      <span className="tm-exam-title-name">{quiz.title}</span>
      {open && <Countdown compact />}
      {open && (
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
    ? "Saving failed. Tell your teacher."
    : sync.offline
      ? `Offline: ${sync.pending} change${sync.pending === 1 ? "" : "s"} saved on this computer`
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
  const { phase, error, results, quiz, tasks, lock, resultsSlow } = useExam();
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
  if (phase === "submitting") return <SubmittingCard />;
  if (phase === "locked" && lock) return <LockCard reason={lock.reason} detail={lock.detail} />;
  if (phase === "submitted") {
    const released = results?.status === "released";
    return (
      <div className="tm-exam-overlay" role="status">
        <div className="tm-exam-card tm-exam-results">
          <Codicon name="pass-filled" className="tm-exam-card-icon is-ok" />
          <h2>Submitted</h2>
          <p>{quiz?.title} was submitted to Task Mentor.</p>
          {(!results || results.status === "grading") && resultsSlow ? (
            <p className="tm-muted" data-testid="exam-grading-slow">
              Grading takes longer than usual. Your results will appear in Task Mentor.
            </p>
          ) : !results || results.status === "grading" ? (
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

const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One card while the final code goes to Task Mentor, including when time is up offline. */
function SubmittingCard() {
  const { timeUp, retryAt, sync, deadline } = useExam();
  const grace = useWorkbench((s) => s.policy.allow_offline_grace_minutes);
  const waiting = retryAt !== null || sync.offline;
  useNow(waiting);
  const secs = retryAt !== null ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  return (
    <div className="tm-exam-overlay" role="status" aria-live="polite" data-testid="exam-submitting">
      <div className="tm-exam-card">
        <Codicon name={waiting ? "cloud-offline" : "sync"} className={`tm-exam-card-icon ${waiting ? "" : "codicon-modifier-spin"}`} />
        <h2>{timeUp ? "Time is up" : "Submitting…"}</h2>
        {waiting ? (
          <>
            <p>Your work is saved on this computer and will be sent when you're back online.</p>
            <p className="tm-muted" data-testid="exam-retry">
              {secs > 0 ? `Can't reach Task Mentor. Trying again in ${secs} s.` : "Trying to reach Task Mentor…"} Keep TMCode open.
            </p>
            {timeUp && deadline && grace > 0 && <p className="tm-muted">Task Mentor accepts it until {at(deadline + grace * 60_000)}.</p>}
          </>
        ) : (
          <p className="tm-muted">Sending your final code to Task Mentor.</p>
        )}
      </div>
    </div>
  );
}

const LOCK_COPY: Record<LockReason, { title: string; body: string; icon: string }> = {
  superseded: {
    title: "Continued on another computer",
    body: "This exam was opened on another computer or window. Continue there. Your work up to now is saved. To continue here, open the exam from Task Mentor again.",
    icon: "device-desktop",
  },
  revoked: { title: "Your exam session was ended", body: "Your teacher or Task Mentor ended this session. Your saved work stays with Task Mentor.", icon: "circle-slash" },
  ended: { title: "This exam has ended", body: "Your saved work stays with Task Mentor.", icon: "watch" },
  submit_failed: { title: "Submitting failed", body: "Your work is saved on this computer.", icon: "error" },
  time_rejected: {
    title: "Time is up",
    body: "Task Mentor did not accept your last changes because the time had ended. Your work is saved on this computer. Tell your teacher.",
    icon: "watch",
  },
};

/** A locked session: why, and the one thing the student can still do. */
function LockCard({ reason, detail }: { reason: LockReason; detail?: string }) {
  const copy = LOCK_COPY[reason];
  return (
    <div className="tm-exam-overlay" role="alert" data-testid="exam-locked">
      <div className="tm-exam-card">
        <Codicon name={copy.icon} className={`tm-exam-card-icon ${reason === "submit_failed" ? "is-error" : ""}`} />
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        {detail && <p className="tm-muted">{detail}</p>}
        {reason === "submit_failed" ? (
          <button type="button" className="tm-button" onClick={() => void submitExam({ auto: true })}>
            Try again
          </button>
        ) : (
          <button type="button" className="tm-button tm-button--secondary" onClick={() => stopExam()}>
            Close exam
          </button>
        )}
      </div>
    </div>
  );
}
