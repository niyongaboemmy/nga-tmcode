import { useEffect, useMemo, useRef, useState } from "react";
import { formatKeybinding } from "../commands/registry";
import { getPlatform, openFile, showDialog, useWorkbench, type EditorInput } from "../state/store";
import { openExternalUrl } from "../terminal/browser";
import { ActionButton, Codicon } from "../widgets/icons";
import { SkeletonLines } from "../widgets/Skeleton";
import { taskMentorWeb } from "../projects/commands";
import { useProjects } from "../projects/service";
import { ProgressBar } from "./GradingView";
import { closeReview, keyOf, loadRoster, openGrading, openSubmission, parseKey, previewSubmission, progressOf, saveGrade, selectStudent, useGrading, type Criterion, type Roster, type RosterRow, type RowState } from "./service";

type Input = Extract<EditorInput, { kind: "grading" }>;
type Filter = "to-grade" | "graded" | "working" | "not-started" | "all";

const STATE: Record<RowState, { label: string; tone: string }> = {
  submitted: { label: "To grade", tone: "info" },
  graded: { label: "Graded", tone: "success" },
  in_progress: { label: "Working", tone: "muted" },
  not_started: { label: "Not started", tone: "muted" },
};
const inFilter = (f: Filter, r: RosterRow) =>
  f === "all" || (f === "to-grade" && r.state === "submitted") || (f === "graded" && r.state === "graded") || (f === "working" && r.state === "in_progress") || (f === "not-started" && r.state === "not_started");

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

interface Draft {
  scores: (number | null)[];
  comments: string[];
  score: number | null;
  feedback: string;
}
/** Unsaved grades survive the tab reopening (loading a review folder reopens it). */
const drafts = new Map<string, Draft>();

function draftFrom(roster: Roster, row: RosterRow): Draft {
  const rubric = roster.activity.rubric;
  const g = row.grade;
  const scores = rubric.map((_, i) => g?.rubric_scores?.find((s) => s.index === i)?.score ?? null);
  const comments = rubric.map((_, i) => g?.rubric_scores?.find((s) => s.index === i)?.comment ?? "");
  // Feedback composed by Task Mentor carries "Criteria notes:"; edit only the teacher's part.
  const feedback = (g?.feedback ?? "").split(/\n\nCriteria notes:\n/)[0];
  return { scores, comments, score: rubric.length ? null : (g?.score ?? null), feedback };
}

/** The review folder's top-level files, opened in the code group (not the grading tab's). */
function SubmissionFiles() {
  const entries = useWorkbench((s) => s.dirs[""]);
  const files = (entries ?? []).filter((e) => e.kind === "file" && !e.name.startsWith(".")).slice(0, 10);
  if (!files.length) return null;
  const open = (path: string) => {
    const groups = useWorkbench.getState().groups;
    const code = groups.find((g) => !g.editors.some((e) => e.kind === "grading"))?.id ?? groups[0].id;
    openFile(path, { pinned: true, group: code });
  };
  return (
    <div className="tm-grade-files" aria-label="Submitted files">
      {files.map((f) => (
        <button key={f.name} type="button" className="tm-filter-chip" onClick={() => open(f.name)} title={`Open ${f.name}`}>
          <Codicon name="file" /> {f.name}
        </button>
      ))}
    </div>
  );
}

function GradePanel({ gkey, roster, row, onNext }: { gkey: string; roster: Roster; row: RosterRow; onNext: () => void }) {
  const rubric: Criterion[] = roster.activity.rubric;
  const max = roster.activity.max_points;
  const dkey = `${gkey}:${row.student?.id}`;
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(dkey) ?? draftFrom(roster, row));
  const [openComment, setOpenComment] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const review = useGrading((s) => s.review);
  const loadingReview = useGrading((s) => s.loadingReview);
  const pristine = useMemo(() => JSON.stringify(draftFrom(roster, row)), [roster, row]);
  const dirty = JSON.stringify(draft) !== pristine;
  // A refresh from Task Mentor (someone else graded, a resubmission) updates the form unless it has unsaved edits.
  useEffect(() => {
    if (!drafts.has(dkey)) setDraftState(JSON.parse(pristine) as Draft);
  }, [pristine, dkey]);
  const setDraft = (d: Draft) => {
    if (JSON.stringify(d) === pristine) drafts.delete(dkey);
    else drafts.set(dkey, d);
    setDraftState(d);
  };
  const total = rubric.length ? draft.scores.reduce<number>((n, s) => n + (s ?? 0), 0) : (draft.score ?? 0);
  const complete = rubric.length ? draft.scores.every((s) => s !== null) : draft.score !== null;
  const gradable = roster.activity.can_grade && (row.state === "submitted" || row.state === "graded");
  const loaded = !!review && review.project_id === row.project?.id && review.revision_id === row.link?.revision_id;
  const loading = !!row.project && loadingReview === `${row.project.id}@${row.link?.revision_id}`;

  const save = async (next: boolean) => {
    if (!row.student) return;
    setSaving(true);
    const ok = await saveGrade(gkey, row.student.id, {
      rubric_scores: rubric.map((_, i) => ({ index: i, score: draft.scores[i] ?? 0, comment: draft.comments[i]?.trim() || null })),
      score: rubric.length ? null : draft.score,
      feedback: draft.feedback,
    });
    setSaving(false);
    if (ok) {
      drafts.delete(dkey);
      if (next) onNext();
    }
    // (the roster reload brings the saved grade back as the new pristine state)
  };

  return (
    <div
      className="tm-grade-panel"
      data-testid="grade-panel"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && gradable && complete) {
          e.preventDefault();
          void save(true);
        }
      }}
    >
      <header className="tm-grade-student">
        <span className="tm-grade-avatar" aria-hidden>
          {initials(row.student?.name ?? "?")}
        </span>
        <div className="tm-grade-student-text">
          <h2>{row.student?.name ?? "Unknown student"}</h2>
          <div className="tm-assignment-facts">
            <span className={`tm-chip tm-state-chip is-${STATE[row.state].tone}`}>{STATE[row.state].label}</span>
            {row.submitted_at && (
              <span className="tm-fact">
                <Codicon name="send" /> {when(row.submitted_at)}
              </span>
            )}
            {row.link?.revision_number && (
              <span className="tm-fact" title="The version the student handed in">
                <Codicon name="git-commit" /> version {row.link.revision_number}
              </span>
            )}
            {row.late && <span className="tm-chip is-late">Late</span>}
          </div>
        </div>
      </header>

      <div className="tm-grade-actions">
        {row.project?.kind === "github" ? (
          <button type="button" className="tm-button tm-button--secondary" onClick={() => row.project?.repo_url && void openExternalUrl(row.link?.git_commit ? `${row.project.repo_url.replace(/\.git$/, "")}/tree/${row.link.git_commit}` : row.project.repo_url)} title="The repository at the submitted commit">
            <Codicon name="github" /> Open on GitHub
          </button>
        ) : loaded ? (
          <span className="tm-grade-opened" data-testid="load-project" title="The files in the editor are this student's submitted version. You can read and run them; edits are refused.">
            <Codicon name="pass-filled" /> Their project is open in the editor (read-only)
          </span>
        ) : (
          <button
            type="button"
            className="tm-button"
            disabled={!row.link?.revision_id || loading}
            onClick={() => void openSubmission(gkey, row)}
            data-testid="load-project"
            title={row.link?.revision_id ? "Open the submitted version in the editor (read-only)" : "Nothing submitted yet"}
          >
            <Codicon name={loading ? "loading" : "folder-opened"} className={loading ? "codicon-modifier-spin" : ""} />
            {loading ? "Opening…" : "Open Their Project"}
          </button>
        )}
        <button type="button" className="tm-button tm-button--secondary" disabled={!row.link?.revision_id || row.project?.kind === "github"} onClick={() => void previewSubmission(row)} title="Run the submitted website in the built-in browser">
          <Codicon name="globe" /> Preview
        </button>
      </div>

      {loaded && <SubmissionFiles />}

      {!gradable && (
        <p className="tm-grade-hint" data-testid="grade-hint">
          <Codicon name="info" />{" "}
          {!roster.activity.can_grade
            ? "You can follow this practical, but only its teachers can grade it."
            : row.state === "in_progress"
              ? "Still working: you can grade once the work is submitted."
              : "Not started yet."}
        </p>
      )}

      <section className="tm-grade-criteria" aria-label="Criteria">
        <div className="tm-grade-criteria-head">
          <h3>{rubric.length ? "Criteria" : "Score"}</h3>
          {gradable && rubric.length > 0 && (
            <span className="tm-grade-bulk">
              <button type="button" className="tm-link-button" onClick={() => setDraft({ ...draft, scores: rubric.map((c) => c.max_score) })} data-testid="grade-full-marks" title="Give every criterion its full score, then lower what was missed">
                Full marks
              </button>
              {draft.scores.some((x) => x !== null) && (
                <button type="button" className="tm-link-button" onClick={() => setDraft({ ...draft, scores: rubric.map(() => null) })} title="Clear every score">
                  Clear
                </button>
              )}
            </span>
          )}
          <span className={`tm-grade-total ${complete ? "" : "is-incomplete"}`} data-testid="grade-total" title={complete ? "Total of the criteria" : "Score every criterion"}>
            {total}
            <small> / {max}</small>
          </span>
        </div>
        {rubric.length ? (
          rubric.map((c, i) => {
            const v = draft.scores[i];
            return (
              <div key={i} className="tm-grade-criterion" data-testid="grade-criterion">
                <div className="tm-grade-criterion-name" title={c.description ? `${c.criteria}\n${c.description}` : c.criteria}>
                  {c.criteria}
                </div>
                {c.description && <p className="tm-grade-criterion-desc">{c.description}</p>}
                <div className="tm-grade-criterion-row">
                  <div className="tm-grade-quick" role="group" aria-label={`Quick scores for ${c.criteria}`}>
                    {[0, Math.round((c.max_score / 2) * 2) / 2, c.max_score].map((q, qi) => (
                      <button key={qi} type="button" className={`tm-filter-chip ${v === q ? "is-active" : ""}`} disabled={!gradable} onClick={() => setDraft({ ...draft, scores: draft.scores.map((s, j) => (j === i ? q : s)) })} title={qi === 0 ? "Not met" : qi === 1 ? "Partly met" : "Fully met"}>
                        {q}
                      </button>
                    ))}
                  </div>
                  <input
                    className="tm-input tm-grade-score"
                    type="number"
                    min={0}
                    max={c.max_score}
                    step={0.5}
                    value={v ?? ""}
                    disabled={!gradable}
                    aria-label={`${c.criteria} score out of ${c.max_score}`}
                    onChange={(e) => {
                      const n = e.target.value === "" ? null : Math.max(0, Math.min(c.max_score, Number(e.target.value)));
                      setDraft({ ...draft, scores: draft.scores.map((s, j) => (j === i ? n : s)) });
                    }}
                  />
                  <span className="tm-grade-max">/ {c.max_score}</span>
                  <button type="button" className={`tm-action ${draft.comments[i] ? "is-active" : ""}`} title={draft.comments[i] ? "Edit the note for this criterion" : "Add a note for this criterion"} aria-label={`Note for ${c.criteria}`} onClick={() => setOpenComment(openComment === i ? null : i)} disabled={!gradable}>
                    <Codicon name={draft.comments[i] ? "comment-discussion" : "comment"} />
                  </button>
                </div>
                {openComment === i && (
                  <textarea
                    className="tm-input tm-grade-note"
                    rows={2}
                    autoFocus
                    placeholder={`A note about ${c.criteria.toLowerCase()} (the student reads it)`}
                    value={draft.comments[i]}
                    onChange={(e) => setDraft({ ...draft, comments: draft.comments.map((s, j) => (j === i ? e.target.value : s)) })}
                  />
                )}
              </div>
            );
          })
        ) : (
          <div className="tm-grade-criterion-row">
            <span className="tm-grade-criterion-name">Score</span>
            <input className="tm-input tm-grade-score" type="number" min={0} max={max} step={0.5} value={draft.score ?? ""} disabled={!gradable} aria-label={`Score out of ${max}`} onChange={(e) => setDraft({ ...draft, score: e.target.value === "" ? null : Math.max(0, Math.min(max, Number(e.target.value))) })} />
            <span className="tm-grade-max">/ {max}</span>
          </div>
        )}
      </section>

      <section className="tm-grade-feedback">
        <h3>Feedback</h3>
        <textarea className="tm-input" rows={4} placeholder="What went well, and what to improve" value={draft.feedback} disabled={!gradable} onChange={(e) => setDraft({ ...draft, feedback: e.target.value })} data-testid="grade-feedback" />
      </section>

      <footer className="tm-grade-footer">
        <span className={`tm-muted ${gradable && !complete ? "is-hint" : ""}`} data-testid="grade-status">
          {gradable && !complete
            ? rubric.length
              ? `Score ${draft.scores.filter((x) => x === null).length === rubric.length ? "every criterion" : `${draft.scores.filter((x) => x === null).length} more criteri${draft.scores.filter((x) => x === null).length === 1 ? "on" : "a"}`} to save`
              : "Enter a score to save"
            : dirty
              ? "Unsaved changes"
              : row.grade?.graded_at
                ? `Graded ${when(row.grade.graded_at)}`
                : ""}
        </span>
        <button type="button" className="tm-button tm-button--secondary" disabled={!gradable || !complete || saving} onClick={() => void save(false)} data-testid="grade-save">
          Save
        </button>
        <button type="button" className="tm-button" disabled={!gradable || !complete || saving} onClick={() => void save(true)} data-testid="grade-save-next" title={`Save, then the next one to grade (${formatKeybinding("mod+enter", getPlatform().os)})`}>
          <Codicon name={saving ? "loading" : "arrow-right"} className={saving ? "codicon-modifier-spin" : ""} /> Save &amp; Next
        </button>
      </footer>
    </div>
  );
}

/** Grading one assignment or quiz practical question: progress, submissions, the student's project, criteria. */
export function GradingEditor({ input }: { input: Input }) {
  const key = input.gradingKey;
  const roster = useGrading((s) => s.rosters[key]);
  const error = useGrading((s) => s.rosterErrors[key]);
  const selected = useGrading((s) => s.selected[key]);
  const [filter, setFilter] = useState<Filter>("to-grade");
  const [query, setQuery] = useState("");
  const [autoLoad, setAutoLoad] = useState(true);
  // Beside the code the tab is narrow: the roster folds into a switcher bar so the grade form fits.
  const [showList, setShowList] = useState(false);
  // Save & Next found nothing left: show the finish line instead of the last form.
  const [finished, setFinished] = useState(false);
  const reviewing = useGrading((s) => s.review);
  const listRef = useRef<HTMLDivElement>(null);
  useProjects((s) => s.account);

  useEffect(() => {
    void getPlatform()
      .store.get<boolean>("grading.autoLoad")
      .then((v) => v === false && setAutoLoad(false))
      .catch(() => {});
  }, []);
  // Stays in sync with Task Mentor while open (another teacher grading, students submitting).
  useEffect(() => {
    if (!roster) void loadRoster(key);
    const t = setInterval(() => void loadRoster(key, { quiet: true }), 30_000);
    return () => clearInterval(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nothing to grade: show everyone.
  useEffect(() => {
    if (roster && filter === "to-grade" && roster.counts.to_grade === 0 && !selected) setFilter("all");
  }, [roster]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (roster?.rows ?? []).filter((r) => inFilter(filter, r) && (!query || (r.student?.name ?? "").toLowerCase().includes(query.toLowerCase()))), [roster, filter, query]);
  const row = roster?.rows.find((r) => r.student?.id === selected) ?? null;

  const choose = async (r: RosterRow) => {
    if (!r.student || r.student.id === selected) return;
    const cur = selected != null ? drafts.get(`${key}:${selected}`) : undefined;
    if (cur && roster) {
      const was = roster.rows.find((x) => x.student?.id === selected);
      if (was && JSON.stringify(cur) !== JSON.stringify(draftFrom(roster, was))) {
        const c = await showDialog({
          severity: "warning",
          message: `Leave ${was.student?.name}'s grade unsaved?`,
          detail: "Your scores stay as a draft in this window; they are not saved to Task Mentor yet.",
          buttons: [
            { id: "leave", label: "Keep as Draft", primary: true },
            { id: "cancel", label: "Cancel" },
          ],
          cancelId: "cancel",
        });
        if (c !== "leave") return;
      }
    }
    selectStudent(key, r.student.id);
    setFinished(false);
    setShowList(false);
    if (autoLoad && r.project?.kind === "tm" && r.link?.revision_id) void openSubmission(key, r);
  };

  const next = () => {
    if (!roster) return;
    const all = roster.rows;
    const i = all.findIndex((r) => r.student?.id === selected);
    const after = [...all.slice(i + 1), ...all.slice(0, Math.max(0, i))].find((r) => r.state === "submitted" && r.student?.id !== selected);
    if (after) void choose(after);
    else setFinished(true);
  };
  /** Previous / next in the list as filtered (the switcher's arrows, ↑/↓ in the list). */
  const step = (d: 1 | -1) => {
    const i = rows.findIndex((r) => r.student?.id === selected);
    const n = rows[i + d];
    if (n) void choose(n);
  };

  if (!roster) {
    return (
      <div className="tm-grade-page" data-testid="grading-page">
        {error ? <p className="tm-error-text">{error}</p> : <SkeletonLines lines={8} />}
      </div>
    );
  }
  const p = progressOf(roster)!;
  const a = roster.activity;
  const counts: Record<Filter, number> = {
    "to-grade": roster.counts.to_grade,
    graded: roster.counts.graded,
    working: p.inProgress,
    "not-started": roster.rows.filter((r) => r.state === "not_started").length,
    all: roster.rows.length,
  };

  return (
    <div className={`tm-grade-page ${row ? "has-selection" : ""}`} data-testid="grading-page">
      <header className="tm-grade-head">
        <div className="tm-assignment-kicker">
          <Codicon name={a.type === "quiz" ? "checklist" : "notebook"} />
          <span>{a.type === "quiz" ? `Quiz practical · ${a.title}` : "Assignment practical"}</span>
          {a.due_date && <span>· due {when(a.due_date)}</span>}
          <span>· {a.max_points} points</span>
        </div>
        <div className="tm-grade-title-row">
          <h1>{a.question ? a.question.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : a.title}</h1>
          {a.type === "quiz" && a.questions.length > 1 && (
            <select className="tm-select" aria-label="Practical question" value={a.question?.id ?? ""} onChange={(e) => openGrading(keyOf("quiz", a.id, Number(e.target.value)))}>
              {a.questions.map((q) => (
                <option key={q.question_id} value={q.question_id}>
                  {q.title}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="tm-action" title="Refresh from Task Mentor" aria-label="Refresh" onClick={() => void loadRoster(key)}>
            <Codicon name="refresh" />
          </button>
          <button
            type="button"
            className="tm-action"
            title="Open the grading page in Task Mentor"
            aria-label="Open in Task Mentor"
            onClick={() => {
              const api = useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com";
              const { type, id } = parseKey(key);
              void openExternalUrl(`${taskMentorWeb(api)}/grading/practical/${type}/${id}`);
            }}
          >
            <Codicon name="link-external" />
          </button>
        </div>
        <div className="tm-grade-progress-row" data-testid="grading-progress">
          <ProgressBar graded={p.graded} toGrade={p.toGrade} inProgress={p.inProgress} total={Math.max(p.total, 1)} />
          <div className="tm-grade-legend">
            <span className="is-graded">
              <b>{p.graded}</b> graded
            </span>
            <span className="is-to-grade">
              <b>{p.toGrade}</b> to grade
            </span>
            <span className="is-in-progress">
              <b>{p.inProgress}</b> working
            </span>
            <span>
              <b>{p.pct}%</b> of submissions graded
            </span>
          </div>
        </div>
      </header>

      <div className={`tm-grade-body ${row && !finished ? "has-selection" : ""} ${showList ? "show-list" : ""}`}>
        <aside className="tm-grade-list" aria-label="Students">
          <div className="tm-grade-filters" role="tablist" aria-label="Show">
            {(["to-grade", "graded", "working", "not-started", "all"] as Filter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={`tm-filter-chip ${filter === f ? "is-active" : ""}`} onClick={() => setFilter(f)} data-testid={`grade-filter-${f}`}>
                {{ "to-grade": "To grade", graded: "Graded", working: "Working", "not-started": "Not started", all: "All" }[f]} <span>{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="tm-input-box tm-grade-search">
            <input className="tm-input" placeholder="Find a student" aria-label="Find a student" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label className="tm-switch-row tm-grade-autoload" title="Selecting a student opens their submitted project in this window">
            <input
              type="checkbox"
              role="switch"
              className="tm-switch"
              checked={autoLoad}
              onChange={(e) => {
                setAutoLoad(e.target.checked);
                void getPlatform().store.set("grading.autoLoad", e.target.checked).catch(() => {});
              }}
            />
            <span>Open each student's project when selected</span>
          </label>
          <div
            className="tm-grade-rows"
            ref={listRef}
            role="listbox"
            aria-label="Submissions"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const i = rows.findIndex((r) => r.student?.id === selected);
              const n = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
              if (n) void choose(n);
            }}
          >
            {rows.length === 0 && <p className="tm-muted tm-projects-hint">{filter === "to-grade" ? "Nothing waiting to be graded." : "No students here."}</p>}
            {rows.map((r) => (
              <div
                key={r.student?.id ?? r.project?.id}
                role="option"
                aria-selected={r.student?.id === selected}
                className={`tm-grade-row ${r.student?.id === selected ? "is-selected" : ""}`}
                data-testid="grade-row"
                onClick={() => void choose(r)}
                title={`${r.student?.name ?? ""}\n${STATE[r.state].label}${r.submitted_at ? ` · ${when(r.submitted_at)}` : ""}${r.late ? " · late" : ""}`}
              >
                <span className={`tm-grade-avatar is-${STATE[r.state].tone}`} aria-hidden>
                  {initials(r.student?.name ?? "?")}
                </span>
                <span className="tm-assignment-text">
                  <span className="tm-project-name">{r.student?.name ?? "Unknown"}</span>
                  <span className="tm-assignment-sub">
                    <span>{STATE[r.state].label}</span>
                    {r.submitted_at && <span>{when(r.submitted_at)}</span>}
                  </span>
                </span>
                {r.late && <span className="tm-chip is-late">Late</span>}
                {r.state === "graded" && r.grade?.score != null && (
                  <span className="tm-chip is-success">
                    {r.grade.score}/{a.max_points}
                  </span>
                )}
                {drafts.has(`${key}:${r.student?.id}`) && <Codicon name="circle-filled" className="tm-grade-draft" title="Unsaved draft" />}
              </div>
            ))}
          </div>
        </aside>
        <main className="tm-grade-main">
          {row && !finished && (
            <div className="tm-grade-switcher" data-testid="grade-switcher">
              <ActionButton icon="chevron-left" label="Previous student" disabled={rows.findIndex((r) => r.student?.id === selected) <= 0} onClick={() => step(-1)} />
              <button type="button" className="tm-grade-switcher-who" onClick={() => setShowList(!showList)} aria-expanded={showList} title={showList ? "Hide the list of students" : "Show all students"} data-testid="grade-switcher-toggle">
                <span className={`tm-grade-avatar is-${STATE[row.state].tone}`} aria-hidden>
                  {initials(row.student?.name ?? "?")}
                </span>
                <b>{row.student?.name ?? "Unknown"}</b>
                <span className="tm-muted">
                  {rows.some((r) => r.student?.id === selected) ? `${rows.findIndex((r) => r.student?.id === selected) + 1} of ${rows.length}` : ""} · {roster.counts.to_grade} to grade
                </span>
                <Codicon name={showList ? "chevron-up" : "chevron-down"} />
              </button>
              <ActionButton icon="chevron-right" label="Next student" disabled={(() => { const i = rows.findIndex((r) => r.student?.id === selected); return i < 0 || i >= rows.length - 1; })()} onClick={() => step(1)} />
            </div>
          )}
          {finished && roster.counts.to_grade === 0 ? (
            <div className="tm-view-empty tm-grade-empty tm-grade-finished" data-testid="grade-finished">
              <Codicon name="pass-filled" className="tm-projects-hero" />
              <h3>All handed-in work is graded</h3>
              <p className="tm-muted">
                {p.graded} of {p.submitted} graded{p.inProgress ? ` · ${p.inProgress} still working: their work appears here when they submit` : ""}.
              </p>
              <div className="tm-grade-finished-actions">
                {reviewing && (
                  <button type="button" className="tm-button" onClick={() => void closeReview()}>
                    <Codicon name="home" /> Back to My Folder
                  </button>
                )}
                <button
                  type="button"
                  className="tm-button tm-button--secondary"
                  onClick={() => {
                    setFinished(false);
                    setFilter("graded");
                    setShowList(true);
                  }}
                >
                  Review Graded Work
                </button>
              </div>
            </div>
          ) : row && !finished ? (
            <GradePanel key={`${key}:${row.student?.id}`} gkey={key} roster={roster} row={row} onNext={next} />
          ) : (
            <div className="tm-view-empty tm-grade-empty">
              <Codicon name="person" className="tm-projects-hero" />
              <p>{roster.counts.to_grade ? `Select a student to grade. ${roster.counts.to_grade} submission${roster.counts.to_grade === 1 ? " is" : "s are"} waiting.` : "Select a student to see their work."}</p>
              {roster.counts.to_grade > 0 && (
                <button type="button" className="tm-button" onClick={() => void choose(roster.rows.find((r) => r.state === "submitted")!)} data-testid="grade-start">
                  <Codicon name="play" /> Start Grading
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
