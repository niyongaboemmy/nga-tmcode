import { useEffect, useState } from "react";
import { useWorkbench } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonRows } from "../widgets/Skeleton";
import { projectsSupported, signIn, useProjects } from "../projects/service";
import { dueLabel } from "../projects/assignments";
import { closeReview, openGrading, progressOf, refreshGrading, useGrading, type Gradable } from "./service";

/** Graded / to grade / in progress, as one bar. */
export function ProgressBar({ graded, toGrade, inProgress, total, compact }: { graded: number; toGrade: number; inProgress: number; total: number; compact?: boolean }) {
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className={`tm-grade-progress ${compact ? "is-compact" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={graded} aria-label={`${graded} of ${total} graded`}>
      <span className="is-graded" style={{ width: pct(graded) }} />
      <span className="is-to-grade" style={{ width: pct(toGrade) }} />
      <span className="is-in-progress" style={{ width: pct(inProgress) }} />
    </div>
  );
}

/** "2 to grade", "All 3 graded", "1 working, none handed in", "No submissions yet". */
export function workload(p: ReturnType<typeof progressOf>) {
  if (!p) return "Loading…";
  if (p.toGrade > 0) return `${p.toGrade} to grade`;
  if (p.submitted > 0) return `All ${p.graded} graded`;
  if (p.inProgress > 0) return `${p.inProgress} working, none handed in`;
  return "No submissions yet";
}

function ActivityRow({ a }: { a: Gradable }) {
  const roster = useGrading((s) => s.rosters[a.key]);
  const error = useGrading((s) => s.rosterErrors[a.key]);
  const p = progressOf(roster);
  const due = dueLabel(a.due_date);
  const done = !!p && p.submitted > 0 && p.toGrade === 0;
  const viewing = useWorkbench((s) =>
    s.groups.some((g) => {
      const e = g.editors.find((x) => x.id === g.activeId);
      return e?.kind === "grading" && e.gradingKey === a.key;
    }),
  );
  return (
    <div
      className={`tm-list-row tm-grade-activity ${viewing ? "is-viewing" : ""}`}
      aria-selected={viewing}
      role="button"
      tabIndex={0}
      data-testid="grading-activity"
      data-key={a.key}
      title={`${a.question_title ? `${a.title} › ${a.question_title}` : a.title}${a.course_name ? `\n${a.course_name}` : ""}${p ? `\n${p.graded} graded · ${p.toGrade} to grade · ${p.inProgress} still working` : ""}`}
      onClick={() => openGrading(a.key)}
      onKeyDown={(e) => e.key === "Enter" && openGrading(a.key)}
    >
      <Codicon name={a.type === "quiz" ? "checklist" : "notebook"} className="tm-project-kind" />
      <span className="tm-assignment-text">
        <span className="tm-project-name">{a.question_title ?? a.title}</span>
        <span className="tm-assignment-sub">
          {/* The subject heads the group: the row says what is waiting. */}
          {a.question_title && <span className="tm-assignment-course">{a.title}</span>}
          <span className="tm-grade-workload" data-testid="grading-workload">{workload(p)}</span>
          {due && a.status !== "completed" && <span className={`tm-due is-${due.tone}`}>{due.text}</span>}
        </span>
        {p ? <ProgressBar graded={p.graded} toGrade={p.toGrade} inProgress={p.inProgress} total={Math.max(p.total, 1)} compact /> : error ? null : <span className="tm-grade-progress is-compact is-loading" />}
      </span>
      {p &&
        (done ? (
          <span className="tm-chip is-success" title="Everything handed in is graded">
            <Codicon name="check" /> Done
          </span>
        ) : p.toGrade > 0 ? (
          <span className="tm-badge tm-badge--accent" title={`${p.toGrade} to grade`}>
            {p.toGrade}
          </span>
        ) : null)}
      {error && <Codicon name="warning" className="tm-grade-error" title={error} />}
    </div>
  );
}

/** Grading: the TMCode practicals of the teacher's subjects, each with its progress. */
export function GradingView() {
  const account = useProjects((s) => s.account);
  const activities = useGrading((s) => s.activities);
  const loading = useGrading((s) => s.loading);
  const error = useGrading((s) => s.error);
  const review = useGrading((s) => s.review);
  const home = useGrading((s) => s.homeRoot);
  const rosters = useGrading((s) => s.rosters);
  useWorkbench((s) => s.workspace);
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"to-grade" | "all">("all");

  useEffect(() => {
    if (account?.signed_in && activities === null) void refreshGrading();
  }, [account?.signed_in, activities]);

  if (!projectsSupported()) return <div className="tm-view-empty">Grading is available in the TMCode desktop app, outside exams.</div>;
  if (!account?.signed_in) {
    return (
      <div className="tm-view-empty tm-projects-signin">
        <Codicon name="tasklist" className="tm-projects-hero" />
        <h3>Grade TMCode practicals</h3>
        <p>Sign in with your NGA account to grade the assignments and quiz practicals of your subjects.</p>
        <button type="button" className="tm-button tm-button--block" onClick={() => void signIn()}>
          <Codicon name="account" /> Sign in with NGA
        </button>
      </div>
    );
  }
  const match = (a: Gradable) => !filter || `${a.title} ${a.question_title ?? ""} ${a.course_name ?? ""}`.toLowerCase().includes(filter.toLowerCase());
  const pending = (a: Gradable) => (progressOf(rosters[a.key])?.toGrade ?? 0) > 0;
  const list = (activities ?? []).filter(match).filter((a) => show === "all" || pending(a));
  const bySubject = new Map<string, Gradable[]>();
  for (const a of list) bySubject.set(a.course_name ?? "Other", [...(bySubject.get(a.course_name ?? "Other") ?? []), a]);
  const totals = (activities ?? []).reduce(
    (t, a) => {
      const p = progressOf(rosters[a.key]);
      return p ? { graded: t.graded + p.graded, toGrade: t.toGrade + p.toGrade, inProgress: t.inProgress + p.inProgress, total: t.total + p.total } : t;
    },
    { graded: 0, toGrade: 0, inProgress: 0, total: 0 },
  );

  return (
    <div className="tm-projects-view" data-testid="grading-view">
      {review && (
        <div className="tm-grade-reviewing" data-testid="grading-reviewing">
          <Codicon name="eye" />
          <span title={`Reviewing ${review.student}'s submission for "${review.activity}" (read-only)`}>
            Reviewing <b>{review.student}</b>
          </span>
          {home && (
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => void closeReview()} title="Close the review and go back to your own folder">
              Back to my folder
            </button>
          )}
        </div>
      )}
      <div className="tm-grade-summary">
        <div className="tm-grade-summary-numbers">
          <span>
            <b>{totals.toGrade}</b> to grade
          </span>
          <span>
            <b>{totals.graded}</b> graded
          </span>
          <span>
            <b>{totals.inProgress}</b> working
          </span>
        </div>
        <ProgressBar {...totals} total={Math.max(totals.total, 1)} />
      </div>
      <div className="tm-assignments-toolbar">
        <div className="tm-input-box tm-assignments-filter">
          <input className="tm-input" placeholder="Filter practicals" aria-label="Filter practicals" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <ActionButton icon={show === "all" ? "filter" : "filter-filled"} label={show === "all" ? "Show only those with work to grade" : "Show all practicals"} onClick={() => setShow(show === "all" ? "to-grade" : "all")} data-testid="grading-only-pending" />
        <ActionButton icon="refresh" label="Refresh (syncs with Task Mentor)" onClick={() => void refreshGrading()} className={loading ? "is-busy" : ""} />
      </div>
      {error && <p className="tm-error-text">{error}</p>}
      {activities === null ? (
        <SkeletonRows rows={4} label="Loading practicals" />
      ) : activities.length === 0 ? (
        <div className="tm-view-empty">
          <Codicon name="tasklist" className="tm-projects-hero" />
          <p>No TMCode practicals to grade yet. Turn on "TMCode practical" for an assignment, or add a practical question to a quiz, in Task Mentor.</p>
        </div>
      ) : list.length === 0 ? (
        <p className="tm-muted tm-projects-hint">{show === "to-grade" ? "Nothing waiting to be graded." : "No matching practicals."}</p>
      ) : (
        [...bySubject.entries()]
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([subject, items]) => (
            <section key={subject} className="tm-grade-subject" aria-label={subject}>
              <h3 className="tm-grade-subject-title">
                <Codicon name="library" /> {subject}
              </h3>
              {items.map((a) => (
                <ActivityRow key={a.key} a={a} />
              ))}
            </section>
          ))
      )}
    </div>
  );
}
