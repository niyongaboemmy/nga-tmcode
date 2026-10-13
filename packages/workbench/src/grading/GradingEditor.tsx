import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from "react";
import { formatKeybinding } from "../commands/registry";
import { getPlatform, openContextMenu, openFile, showDialog, useWorkbench, type ContextMenuItem, type EditorInput } from "../state/store";
import { openExternalUrl } from "../terminal/browser";
import { ActionButton, Codicon, FileIcon } from "../widgets/icons";
import { SkeletonLines } from "../widgets/Skeleton";
import { openInTaskMentor } from "../projects/taskMentorLinks";
import { useProjects } from "../projects/service";
import { showAssignment } from "../projects/assignments";
import { revealComment } from "./comments";
import { compareWithVersion, diffWithStarter, draftGradeCount, GRADING_SHORTCUTS, openGradingDiff, registerGradingController, releaseDraftGrades } from "./commands";
import { changesAgainst, revisionFiles, starterOf, type Change, type Version } from "./diff";
import { draftFrom, draftKey, dropDraft, inputFromDraft, putDraft, rebaseDraft, setFailed, useDrafts, type Draft } from "./drafts";
import { clampScore, quickScores, rubricMismatch } from "./scoring";
import {
  closeReview,
  draftsSupported,
  isDraftGrade,
  keyOf,
  firstToGrade,
  byHandIn,
  loadRoster,
  openGrading,
  openSubmission,
  parseKey,
  previewSubmission,
  progressOf,
  returnForChanges,
  saveGrade,
  selectStudent,
  useGrading,
  type Criterion,
  type Roster,
  type RosterRow,
  type RowGrade,
  type RowState,
} from "./service";

type Input = Extract<EditorInput, { kind: "grading" }>;
type Filter = "to-grade" | "graded" | "working" | "not-started" | "all";

const STATE: Record<RowState, { label: string; tone: string }> = {
  submitted: { label: "To grade", tone: "info" },
  graded: { label: "Graded", tone: "success" },
  in_progress: { label: "In progress", tone: "muted" },
  not_started: { label: "Not started", tone: "muted" },
};
const inFilter = (f: Filter, r: RosterRow) =>
  f === "all" || (f === "to-grade" && r.state === "submitted") || (f === "graded" && r.state === "graded") || (f === "working" && r.state === "in_progress") || (f === "not-started" && r.state === "not_started");

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
          <FileIcon path={f.name} size={14} /> {f.name}
        </button>
      ))}
    </div>
  );
}

const CHANGE: Record<Change["status"], { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
};

/** Changes vs Starter / Compare with Version… and the files changed since the starter. */
function SubmissionChanges({ row }: { row: RosterRow }) {
  const [state, setState] = useState<{ base: Version | null; changes: Change[] } | "loading" | "error">("loading");
  useEffect(() => {
    let live = true;
    setState("loading");
    void (async () => {
      try {
        const base = await starterOf(row);
        const changes = base ? await changesAgainst(row, base) : [];
        if (live) setState({ base, changes });
      } catch {
        if (live) setState("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [row.project?.id, row.link?.revision_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = typeof state === "object" ? state.base : null;
  return (
    <section className="tm-grade-changes" aria-label="Changes" data-testid="grade-changes">
      <div className="tm-grade-changes-head">
        <h3>{base ? "Changed since the starter" : "Versions"}</h3>
        <span className="tm-grade-changes-actions">
          {base && (
            <button type="button" className="tm-link-button" onClick={() => void diffWithStarter()} data-testid="grade-diff-starter" title="The file in view, starter files ↔ submitted">
              Changes vs Starter
            </button>
          )}
          <button type="button" className="tm-link-button" onClick={() => void compareWithVersion()} data-testid="grade-compare-version" title="The file in view, another version the student saved ↔ submitted">
            Compare with Version…
          </button>
        </span>
      </div>
      {state === "loading" ? (
        <p className="tm-muted tm-grade-changes-note">Comparing with the starter files…</p>
      ) : state === "error" ? (
        <p className="tm-muted tm-grade-changes-note">The starter files could not be loaded.</p>
      ) : !base ? null : state.changes.length === 0 ? (
        <p className="tm-muted tm-grade-changes-note">Nothing changed since the starter files.</p>
      ) : (
        <ul className="tm-grade-change-list">
          {state.changes.map((c) => (
            <li key={c.path}>
              <button type="button" className="tm-grade-change" onClick={() => openGradingDiff(c.path, base, "Starter")} title={`${CHANGE[c.status].label}: open the diff`} data-testid="grade-change">
                <span className={`tm-grade-change-letter is-${c.status}`} aria-label={CHANGE[c.status].label}>
                  {CHANGE[c.status].letter}
                </span>
                <FileIcon path={c.path} size={14} />
                <span className="tm-grade-change-path">{c.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "3 line comments", each one click from its line. */
function LineComments({ draft, loaded, canEdit }: { draft: Draft; loaded: boolean; canEdit: boolean }) {
  const list = draft.annotations;
  if (!list.length && !loaded) return null;
  return (
    <section className="tm-grade-comments" aria-label="Line comments" data-testid="grade-comments">
      <h3>{list.length ? plural(list.length, "line comment") : "Line comments"}</h3>
      {list.length === 0 ? (
        <p className="tm-muted tm-grade-changes-note">{canEdit ? "Click + beside a line of their code, or right-click › Add Comment." : "No line comments."}</p>
      ) : (
        <ul className="tm-grade-comment-list">
          {list.map((a, i) => (
            <li key={`${a.path}:${a.line}:${i}`}>
              <button type="button" className="tm-grade-comment-link" onClick={() => revealComment(a)} title="Show this line" data-testid="grade-comment-link">
                <span className="tm-grade-comment-where">
                  {a.path}:{a.line}
                </span>
                <span className="tm-grade-comment-text">{a.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface PanelApi {
  saveAndNext(): void;
  focus(): void;
  returnForChanges(): boolean;
}

/** Task Mentor's Grading page for this activity (and student). */
function openGradingInTaskMentor(key: string, studentId: number | null) {
  const { type, id, question_id } = parseKey(key);
  openInTaskMentor({ kind: "grading", type, id, question: question_id, student: studentId });
}

/** Save & Next's note for the next panel ("Saved Chloe Coder: 20/20."). */
const filters = new Map<string, Filter>();
let carried: { key: string; from: number; text: string; at: number } | null = null;

/** What the split button's main part does; the teacher's last choice from its menu (L3). */
type SaveMode = "next" | "draft" | "release";
let savedMode: SaveMode = "next";
let modeLoaded = false;
function loadSaveMode(set: (m: SaveMode) => void) {
  if (modeLoaded) return;
  modeLoaded = true;
  void getPlatform()
    .store.get<SaveMode>("grading.saveMode")
    .then((m) => {
      if (m === "next" || m === "draft" || m === "release") {
        savedMode = m;
        set(m);
      }
    })
    .catch(() => {});
}
function rememberSaveMode(m: SaveMode) {
  savedMode = m;
  void getPlatform().store.set("grading.saveMode", m).catch(() => {});
}

function GradePanel({ gkey, roster, row, onNext, apiRef }: { gkey: string; roster: Roster; row: RosterRow; onNext: () => void; apiRef: MutableRefObject<PanelApi | null> }) {
  const rubric: Criterion[] = roster.activity.rubric;
  const max = roster.activity.max_points;
  const quiz = roster.activity.type === "quiz";
  const dkey = draftKey(gkey, row.student?.id);
  const pristine = useMemo(() => draftFrom(roster, row), [roster, row]);
  const stored = useDrafts((s) => s.drafts[dkey]);
  const failed = useDrafts((s) => s.failed[dkey]);
  const draft = stored ?? pristine;
  const [openComment, setOpenComment] = useState<number | null>(null);
  const [saving, setSaving] = useState<null | "draft" | "release">(null);
  // Save & Next: what was just saved for the previous student shows here first.
  // Kept for 15 s (the next panel may mount more than once while the review opens), never on the saved student's own panel.
  const [justSaved, setJustSaved] = useState<string | null>(() => {
    const c = carried;
    return c && c.key === gkey && c.from !== row.student?.id && Date.now() - c.at < 15_000 ? c.text : null;
  });
  const [conflict, setConflict] = useState<RowGrade | null>(null);
  const [warn, setWarn] = useState<Record<string, string>>({});
  const [returning, setReturning] = useState<null | { message: string; error: string | null; busy: boolean; resubmit?: boolean }>(null);
  // Task Mentor's code for the last failed save (DRAFT_NEEDS_SUBMISSION offers Save & Release instead of Retry).
  const [failCode, setFailCode] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [saveMode, setSaveMode] = useState<SaveMode>(savedMode);
  useEffect(() => loadSaveMode(setSaveMode), []);
  const [hasHtml, setHasHtml] = useState<boolean | null>(null);
  const lastSave = useRef<{ release: boolean; next: boolean }>({ release: true, next: false });
  const panelRef = useRef<HTMLDivElement>(null);
  const ids = useId();
  const review = useGrading((s) => s.review);
  const loadingReview = useGrading((s) => s.loadingReview);
  const dirty = !!stored;
  const setDraft = (d: Draft) => {
    setJustSaved(null);
    putDraft(dkey, d, pristine, row.grade?.version ?? null);
  };
  const total = rubric.length ? draft.scores.reduce<number>((n, s) => n + (s ?? 0), 0) : (draft.score ?? 0);
  const complete = rubric.length ? draft.scores.every((s) => s !== null) : draft.score !== null;
  const gradable = roster.activity.can_grade && (row.state === "submitted" || row.state === "graded");
  const loaded = !!review && review.project_id === row.project?.id && review.revision_id === row.link?.revision_id;
  const loading = !!row.project && loadingReview === `${row.project.id}@${row.link?.revision_id}`;
  const drafts = draftsSupported(roster);
  // Someone else saved since this draft began (their version differs from the one it started from).
  const theirs = conflict ?? (stored && stored.base !== undefined && row.grade?.version !== undefined && stored.base !== row.grade.version ? row.grade : null);
  const mismatch = rubricMismatch(rubric, max);

  // Preview only for work with a web page in it.
  useEffect(() => {
    setHasHtml(null);
    if (!row.project || row.project.kind !== "tm" || !row.link?.revision_id) return;
    let live = true;
    revisionFiles(row.project.id, row.link.revision_id)
      .then((files) => live && setHasHtml(files.some((f) => /\.html?$/i.test(f.path))))
      .catch(() => live && setHasHtml(true));
    return () => {
      live = false;
    };
  }, [row.project?.id, row.link?.revision_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (release: boolean, next: boolean, ifVersionOverride?: string | null) => {
    if (!row.student || saving) return;
    lastSave.current = { release, next };
    setSaving(release ? "release" : "draft");
    setJustSaved(null);
    // The version this draft was edited from; unchanged forms answer the grade as it is.
    const ifVersion = ifVersionOverride !== undefined ? ifVersionOverride : stored ? (stored.base ?? null) : (row.grade?.version ?? null);
    // N4/T9: the footer says it. After Save & Next, the next student's footer says what was saved (no toast).
    const r = await saveGrade(gkey, row.student.id, inputFromDraft(roster, draft), { release, ifVersion, quiet: true });
    setSaving(null);
    setFailCode(r.ok ? null : (r.code ?? null));
    if (r.ok) {
      dropDraft(dkey);
      setFailed(dkey, null);
      setConflict(null);
      setJustSaved(r.message);
      if (next) {
        carried = { key: gkey, from: row.student.id, text: `Saved ${row.student.name}: ${r.max_points > 0 ? `${r.score}/${r.max_points}` : r.score}${r.released ? "" : " (draft)"}.`, at: Date.now() };
        onNext();
      }
    } else if (r.conflict) {
      setConflict(r.conflict);
    } else {
      setFailed(dkey, r.error);
    }
  };
  const keepMine = () => {
    const v = theirs?.version ?? null;
    rebaseDraft(dkey, v);
    setConflict(null);
    void save(lastSave.current.release, false, v);
  };
  const useTheirs = () => {
    dropDraft(dkey);
    setFailed(dkey, null);
    setConflict(null);
    void loadRoster(gkey, { quiet: true });
  };

  const focusPanel = () => {
    const el = panelRef.current?.querySelector<HTMLElement>(".tm-grade-criteria input:not([disabled]), .tm-grade-criteria button:not([disabled]), textarea:not([disabled])");
    (el ?? panelRef.current)?.focus();
  };
  const api: PanelApi = {
    saveAndNext: () => {
      if (gradable && complete) void save(true, true);
      else focusPanel();
    },
    focus: focusPanel,
    returnForChanges: () => {
      if (!canReturn) return false;
      setReturning({ message: "", error: null, busy: false });
      return true;
    },
  };
  // The grading tab's commands reach the panel on screen (and nothing once it's gone).
  useEffect(() => {
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  });

  const setScore = (i: number, raw: string, cmax: number) => {
    const { value, clamped } = clampScore(raw, cmax);
    setWarn({ ...warn, [i]: clamped ? `Scores go from 0 to ${cmax}: ${raw} became ${value ?? "empty"}.` : "" });
    if (i < 0) setDraft({ ...draft, score: value });
    else setDraft({ ...draft, scores: draft.scores.map((s, j) => (j === i ? value : s)) });
  };

  const missing = draft.scores.filter((x) => x === null).length;
  const status = saving
    ? saving === "draft"
      ? "Saving the draft…"
      : "Saving…"
    : failed
      ? "Not saved"
      : dirty
        ? "Unsaved changes"
        : justSaved
          ? justSaved // Save & Next: what was saved for the previous student (T9), until this one is touched
          : gradable && !complete
            ? rubric.length
              ? "" // shown on the first criterion without a score
              : "Enter a score to save"
            : isDraftGrade(row)
              ? "Draft: the student doesn't see it yet"
              : row.grade?.graded_at
                ? `Graded ${when(row.grade.graded_at)}`
                : "";
  const os = getPlatform().os;
  // Task Mentor says where Return works (not quiz practicals); graded work can be reopened with Allow Resubmission.
  const canReturn = (roster.activity.can_return ?? !quiz) && roster.activity.can_grade && (row.state === "submitted" || row.state === "graded") && row.project?.kind === "tm";
  const openOnGitHub = () => row.project?.repo_url && void openExternalUrl(row.link?.git_commit ? `${row.project.repo_url.replace(/\.git$/, "")}/tree/${row.link.git_commit}` : row.project.repo_url);
  const moreItems: ContextMenuItem[] = [
    ...(row.project?.kind !== "github" && hasHtml !== false
      ? [{ kind: "item" as const, label: "Preview the Website", disabled: !row.link?.revision_id || hasHtml === null, run: () => void previewSubmission(row) }]
      : []),
    ...(loaded && row.project?.kind === "tm" ? [{ kind: "item" as const, label: "Compare with Version…", run: () => void compareWithVersion() }] : []),
    ...(row.project?.kind === "tm"
      ? [{ kind: "item" as const, label: "Run the Student's Unit Tests", disabled: !row.link?.revision_id, run: () => void import("./unitTests").then((m) => m.runStudentUnitTests(gkey, row)) }]
      : []),
    ...(canReturn && !returning ? [{ kind: "separator" as const }, { kind: "item" as const, label: "Return for Changes…", run: () => setReturning({ message: "", error: null, busy: false }) }] : []),
    { kind: "separator" },
    { kind: "item", label: shortcuts ? "Hide Shortcuts" : "Shortcuts", run: () => setShortcuts(!shortcuts) },
  ];
  // The one primary button (L3): Save & Next by default; the menu's last choice is remembered.
  const modeOf: Record<SaveMode, { label: string; testId: string; run: () => void; title: string }> = {
    next: { label: "Save & Next", testId: "grade-save-next", run: () => void save(true, true), title: `Save, then the next one to grade (${formatKeybinding("mod+enter", getPlatform().os)})` },
    draft: { label: "Save Draft", testId: "grade-save-draft", run: () => void save(false, false), title: "Save without showing it to the student yet. Release it later." },
    release: { label: quiz ? "Save" : "Save & Release", testId: "grade-save", run: () => void save(true, false), title: quiz ? "Save the grade. The student sees it when the quiz results are released." : "Save the grade. The student sees it in Task Mentor." },
  };
  const modes: SaveMode[] = drafts !== false ? ["next", "draft", "release"] : ["next", "release"];
  const primary = modes.includes(saveMode) ? saveMode : "next";
  const disabledSave = !gradable || !complete || !!saving;
  // The first criterion still without a score carries the hint (not the footer).
  const firstMissing = gradable && !complete && rubric.length ? draft.scores.findIndex((x) => x === null) : -1;

  return (
    <div className="tm-grade-panel" data-testid="grade-panel" ref={panelRef} tabIndex={-1} aria-label={`Grade ${row.student?.name ?? "student"}`}>
      <header className="tm-grade-student">
        <span className="tm-grade-avatar" aria-hidden>
          {initials(row.student?.name ?? "?")}
        </span>
        <div className="tm-grade-student-text">
          <h2>{row.student?.name ?? "Unknown student"}</h2>
          <div className="tm-assignment-facts">
            <span className={`tm-chip tm-state-chip is-${STATE[row.state].tone}`}>{STATE[row.state].label}</span>
            {isDraftGrade(row) && (
              <span className="tm-chip is-draft" title="A draft grade: the student doesn't see it until you release it" data-testid="grade-draft-chip">
                Draft
              </span>
            )}
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
          <button type="button" className="tm-button tm-button--secondary" onClick={openOnGitHub} title="The repository at the submitted commit">
            <Codicon name="github" /> Open on GitHub
          </button>
        ) : loaded ? (
          <span className="tm-grade-opened" data-testid="load-project" title="The files in the editor are this student's submitted version. You can read and run them; edits are refused.">
            <Codicon name="pass-filled" /> Their project is open in the editor (read-only)
          </span>
        ) : (
          <button
            type="button"
            className="tm-button tm-button--secondary"
            disabled={!row.link?.revision_id || loading}
            onClick={() => void openSubmission(gkey, row)}
            data-testid="load-project"
            title={row.link?.revision_id ? "Open the submitted version in the editor (read-only)" : "Nothing submitted yet"}
          >
            <Codicon name={loading ? "loading" : "folder-opened"} className={loading ? "codicon-modifier-spin" : ""} />
            {loading ? "Opening…" : "Open Their Project"}
          </button>
        )}
        {/* L3: the rare actions live in one menu, not as buttons above the work. */}
        <button
          type="button"
          className="tm-button tm-button--secondary tm-grade-more"
          aria-haspopup="menu"
          data-testid="grade-more"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenu(r.left, r.bottom + 2, moreItems);
          }}
        >
          More Actions <Codicon name="chevron-down" />
        </button>
      </div>

      {returning && (
        <div className="tm-grade-return" role="group" aria-labelledby={`${ids}-ret`} data-testid="grade-return-form">
          <label id={`${ids}-ret`} htmlFor={`${ids}-ret-msg`}>
            Message to {row.student?.name ?? "the student"}
          </label>
          <textarea id={`${ids}-ret-msg`} className="tm-input" rows={3} autoFocus placeholder="What to change before submitting again" value={returning.message} onChange={(e) => setReturning({ ...returning, message: e.target.value, error: null })} data-testid="grade-return-message" />
          <p className="tm-muted">Their project goes back to them to edit. It leaves your To grade list until they submit again.</p>
          {returning.error && (
            <p className={returning.resubmit ? "tm-grade-warn" : "tm-grade-inline-error"} role="alert" data-testid="grade-return-error">
              <Codicon name={returning.resubmit ? "warning" : "error"} /> {returning.error}
            </p>
          )}
          <div className="tm-grade-return-buttons">
            <button
              type="button"
              className="tm-button"
              disabled={returning.busy}
              data-testid={returning.resubmit ? "grade-allow-resubmission" : "grade-return-send"}
              onClick={async () => {
                setReturning({ ...returning, busy: true });
                const r = await returnForChanges(gkey, row, returning.message, !!returning.resubmit);
                setReturning(r.ok ? null : { ...returning, busy: false, error: r.error, resubmit: !!r.canAllowResubmission || returning.resubmit });
              }}
            >
              {returning.resubmit ? "Allow Resubmission" : "Return to Student"}
            </button>
            <button type="button" className="tm-button tm-button--secondary" onClick={() => setReturning(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}


      {!gradable && (
        <p className="tm-grade-hint" data-testid="grade-hint">
          <Codicon name="info" />{" "}
          {!roster.activity.can_grade
            ? "You can follow this activity, but only its teachers can grade it."
            : row.state === "in_progress"
              ? "In progress: you can grade once the work is submitted."
              : "Not started yet."}{" "}
          {/* W6: a way on, not a dead end. */}
          {roster.activity.type === "assignment" && row.state === "in_progress" ? (
            <button type="button" className="tm-link-button" onClick={() => showAssignment(roster.activity.id)} data-testid="grade-live-status">
              See Their Live Status
            </button>
          ) : (
            <button type="button" className="tm-link-button" onClick={() => openGradingInTaskMentor(gkey, row.student?.id ?? null)} data-testid="grade-open-tm">
              Open in Task Mentor
            </button>
          )}
        </p>
      )}

      {theirs && gradable && (
        <div className="tm-grade-conflict" role="alert" data-testid="grade-conflict">
          <Codicon name="warning" />
          <span>
            Graded by <b>{theirs.graded_by?.name ?? "another teacher"}</b>
            {theirs.graded_at ? ` at ${when(theirs.graded_at)}` : ""} while you were editing{theirs.score != null ? ` (${theirs.score}/${max})` : ""}.
          </span>
          <span className="tm-grade-conflict-actions">
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={useTheirs} data-testid="grade-use-theirs">
              Use Theirs
            </button>
            <button type="button" className="tm-button tm-button--small" onClick={keepMine} disabled={!complete || !!saving} data-testid="grade-keep-mine">
              Keep Mine and Save
            </button>
          </span>
        </div>
      )}

      <section className="tm-grade-criteria" aria-label="Criteria">
        <div className="tm-grade-criteria-head">
          <h3>{rubric.length ? "Criteria" : "Final grade"}</h3>
          {gradable && rubric.length === 0 && max > 0 && (
            <span className="tm-grade-bulk">
              <button type="button" className="tm-link-button" onClick={() => setDraft({ ...draft, score: max })} data-testid="grade-full-marks" title="Give the full grade, then lower it if something was missed">
                Full marks
              </button>
            </span>
          )}
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
            {max > 0 && <small> / {max}</small>}
          </span>
        </div>
        {row.grade?.graded_by && (
          <p className="tm-grade-by" data-testid="graded-by">
            Graded by {row.grade.graded_by.name}
            {row.grade.graded_at ? ` · ${when(row.grade.graded_at)}` : ""}
            {isDraftGrade(row) ? ` · draft${row.grade.released_score != null ? `; the student still sees ${row.grade.released_score}/${max}` : ""}` : ""}
          </p>
        )}
        {mismatch && (
          <p className="tm-grade-warn" data-testid="grade-points-mismatch">
            <Codicon name="warning" /> {mismatch}
          </p>
        )}
        {rubric.length ? (
          rubric.map((c, i) => {
            const v = draft.scores[i];
            return (
              <div key={i} className={`tm-grade-criterion ${i === firstMissing ? `is-missing ${draft.scores.some((x) => x !== null) ? "is-started" : ""}` : ""}`} data-testid="grade-criterion">
                <div className="tm-grade-criterion-name" title={c.description ? `${c.criteria}\n${c.description}` : c.criteria}>
                  {c.criteria}
                </div>
                {c.description && <p className="tm-grade-criterion-desc">{c.description}</p>}
                <div className="tm-grade-criterion-row">
                  <div className="tm-grade-quick" role="group" aria-label={`Quick scores for ${c.criteria}`}>
                    {quickScores(c.max_score, c.levels).map((q) => (
                      <button key={q.value} type="button" aria-pressed={v === q.value} className={`tm-filter-chip ${v === q.value ? "is-active" : ""}`} disabled={!gradable} onClick={() => setScore(i, String(q.value), c.max_score)} title={q.title}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                  <input className="tm-input tm-grade-score" type="number" min={0} max={c.max_score} step={0.5} value={v ?? ""} disabled={!gradable} aria-label={`${c.criteria} score out of ${c.max_score}`} onChange={(e) => setScore(i, e.target.value, c.max_score)} />
                  <span className="tm-grade-max">/ {c.max_score}</span>
                  <button type="button" className={`tm-action ${draft.comments[i] ? "is-active" : ""}`} title={draft.comments[i] ? "Edit the note for this criterion" : "Add a note for this criterion"} aria-label={`Note for ${c.criteria}`} aria-expanded={openComment === i} onClick={() => setOpenComment(openComment === i ? null : i)} disabled={!gradable}>
                    <Codicon name={draft.comments[i] ? "comment-discussion" : "comment"} />
                  </button>
                </div>
                {i === firstMissing && (
                  <p className="tm-grade-missing" data-testid="grade-missing">
                    Score {missing === 1 ? "this criterion" : `this and ${missing - 1} more`} to save
                  </p>
                )}
                {warn[i] && (
                  <p className="tm-grade-warn" role="status" data-testid="grade-clamped">
                    <Codicon name="warning" /> {warn[i]}
                  </p>
                )}
                {openComment === i && (
                  <textarea
                    className="tm-input tm-grade-note"
                    rows={2}
                    autoFocus
                    aria-label={`${c.criteria}: note for the student`}
                    placeholder={`A note about ${c.criteria.toLowerCase()} (the student reads it)`}
                    value={draft.comments[i]}
                    onChange={(e) => setDraft({ ...draft, comments: draft.comments.map((s, j) => (j === i ? e.target.value : s)) })}
                  />
                )}
              </div>
            );
          })
        ) : (
          <>
            {/* No criteria for this activity: one final grade (out of its points, when it has them). */}
            <p className="tm-muted tm-grade-final-hint" data-testid="grade-final-hint">
              {max > 0 ? `No criteria for this ${quiz ? "question" : "assignment"}: give one final grade out of ${max}.` : `No criteria or maximum for this ${quiz ? "question" : "assignment"}: give one final grade.`}
            </p>
            <div className="tm-grade-criterion-row">
              <div className="tm-grade-quick" role="group" aria-label="Quick scores">
                {(max > 0 ? quickScores(max) : []).map((q) => (
                  <button key={q.value} type="button" aria-pressed={draft.score === q.value} className={`tm-filter-chip ${draft.score === q.value ? "is-active" : ""}`} disabled={!gradable} onClick={() => setScore(-1, String(q.value), max)} title={q.title}>
                    {q.label}
                  </button>
                ))}
              </div>
              <input
                className="tm-input tm-grade-score"
                type="number"
                min={0}
                max={max > 0 ? max : undefined}
                step={0.5}
                value={draft.score ?? ""}
                disabled={!gradable}
                aria-label={max > 0 ? `Final grade out of ${max}` : "Final grade"}
                onChange={(e) => setScore(-1, e.target.value, max)}
                data-testid="grade-final-score"
              />
              {max > 0 && <span className="tm-grade-max">/ {max}</span>}
            </div>
            {warn[-1] && (
              <p className="tm-grade-warn" role="status" data-testid="grade-clamped">
                <Codicon name="warning" /> {warn[-1]}
              </p>
            )}
          </>
        )}
      </section>

      <section className="tm-grade-feedback">
        <h3>
          <label htmlFor={`${ids}-feedback`}>Feedback</label>
        </h3>
        <textarea id={`${ids}-feedback`} className="tm-input" rows={3} placeholder="What went well, and what to improve" value={draft.feedback} disabled={!gradable} onChange={(e) => setDraft({ ...draft, feedback: e.target.value })} data-testid="grade-feedback" />
      </section>

      <LineComments draft={draft} loaded={loaded} canEdit={gradable} />

      {/* Files and changes: there when wanted, folded so the grade fits (L3). */}
      {loaded && (
        <details className="tm-grade-files-details" data-testid="grade-files">
          <summary>Files and changes</summary>
          <SubmissionFiles />
          {row.project?.kind === "tm" && <SubmissionChanges row={row} />}
        </details>
      )}

      {failed && (
        <div className="tm-grade-save-error" role="alert" data-testid="grade-save-error">
          <Codicon name="error" />
          <span>Not saved: {failed}</span>
          {failCode === "DRAFT_NEEDS_SUBMISSION" ? (
            <button type="button" className="tm-button tm-button--small" onClick={() => void save(true, false)} disabled={!!saving} data-testid="grade-release-instead">
              Save &amp; Release
            </button>
          ) : (
            <button type="button" className="tm-button tm-button--small" onClick={() => void save(lastSave.current.release, lastSave.current.next)} disabled={!!saving} data-testid="grade-retry">
              Retry
            </button>
          )}
        </div>
      )}

      {shortcuts && (
        <dl className="tm-grade-shortcuts" data-testid="grade-shortcuts">
          {GRADING_SHORTCUTS.map((s) => (
            <div key={s.id}>
              <dt>{s.label}</dt>
              <dd>
                <kbd>{formatKeybinding(s.keys, os)}</kbd>
              </dd>
            </div>
          ))}
          <div>
            <dt>Move in the list of students</dt>
            <dd>
              <kbd>↑</kbd> <kbd>↓</kbd>, then <kbd>Enter</kbd>
            </dd>
          </div>
        </dl>
      )}

      <footer className="tm-grade-footer">
        <span className={`tm-muted ${failed ? "is-hint" : ""}`} data-testid="grade-status" role="status" aria-live="polite">
          {status}
        </span>
        <span className="tm-split-button" role="group" aria-label="Save">
          <button type="button" className="tm-button" disabled={disabledSave} onClick={modeOf[primary].run} data-testid={modeOf[primary].testId} title={modeOf[primary].title}>
            <Codicon name={saving ? "loading" : primary === "next" ? "arrow-right" : "save"} className={saving ? "codicon-modifier-spin" : ""} /> {modeOf[primary].label}
          </button>
          <button
            type="button"
            className="tm-button tm-split-button-menu"
            aria-label="More ways to save"
            aria-haspopup="menu"
            disabled={!gradable || !!saving}
            data-testid="grade-save-menu"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openContextMenu(
                r.left,
                r.top,
                modes.map((m) => ({
                  kind: "item" as const,
                  label: `${modeOf[m].label}${m === primary ? " (default)" : ""}`,
                  keybinding: m === "next" ? formatKeybinding("mod+enter", getPlatform().os) : undefined,
                  disabled: disabledSave,
                  run: () => {
                    rememberSaveMode(m);
                    setSaveMode(m);
                    modeOf[m].run();
                  },
                })),
              );
            }}
          >
            <Codicon name="chevron-down" />
          </button>
        </span>
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
  const localDrafts = useDrafts((s) => s.drafts);
  const failedSaves = useDrafts((s) => s.failed);
  // The teacher's filter survives the tab re-mounting while a review folder opens (per practical, this session).
  const [filter, setFilterState] = useState<Filter>(() => filters.get(key) ?? "to-grade");
  const setFilter = (f: Filter) => {
    filters.set(key, f);
    setFilterState(f);
  };
  const [query, setQuery] = useState("");
  const [autoLoad, setAutoLoad] = useState(true);
  // Beside the code the tab is narrow: the roster folds into a switcher bar so the grade form fits.
  const [showList, setShowList] = useState(false);
  // Save & Next found nothing left: show the finish line instead of the last form.
  const [finished, setFinished] = useState(false);
  // The roster's keyboard focus (arrows move it; Enter loads that student).
  const [focusId, setFocusId] = useState<number | null>(null);
  const reviewing = useGrading((s) => s.review);
  const focusMode = useWorkbench((s) => s.settings["grading.focusWhileReviewing"] !== false);
  const listRef = useRef<HTMLDivElement>(null);
  const panelApi = useRef<PanelApi | null>(null);
  const ids = useId();
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
  // W8 (0.16): with work waiting and nobody chosen yet, the first one to grade opens by itself
  // (the oldest hand-in first), so opening a practical is one step, not two.
  const startReq = useGrading((s) => s.startFirst[key] ?? 0);
  const handledStart = useRef<number | null>(null);
  useEffect(() => {
    if (!roster || handledStart.current === startReq) return;
    const asked = handledStart.current !== null || startReq > 0;
    handledStart.current = startReq;
    const current = roster.rows.find((r) => r.student?.id === selected);
    // Opened plainly: only when nobody is chosen. Asked from Home: unless the one shown still waits.
    if (current && (!asked || (current.state === "submitted" && !isDraftGrade(current)))) return;
    const first = firstToGrade(roster);
    if (first) choose(first);
  }, [roster, startReq]); // eslint-disable-line react-hooks/exhaustive-deps

  // "To grade" in grading order (oldest hand-in first), so the list, Next and the counter agree (T3).
  const rows = useMemo(() => {
    const list = (roster?.rows ?? []).filter((r) => inFilter(filter, r) && (!query || (r.student?.name ?? "").toLowerCase().includes(query.toLowerCase())));
    return filter === "to-grade" ? [...list].sort(byHandIn) : list;
  }, [roster, filter, query]);
  // This session's queue: everyone who was waiting since the tab opened ("1 of 2 to grade", then "2 of 2").
  const session = useRef(new Map<number, RosterRow>());
  for (const r of roster?.rows ?? []) if (r.student && r.state === "submitted" && !isDraftGrade(r)) session.current.set(r.student.id, r);
  const queue = [...session.current.values()].sort(byHandIn);
  const queuePos = queue.findIndex((r) => r.student?.id === selected);
  const row = roster?.rows.find((r) => r.student?.id === selected) ?? null;

  const choose = (r: RosterRow) => {
    if (!r.student) return;
    setFocusId(r.student.id);
    // The dropdown list closes on any choice, the open student too (it covers the form).
    setShowList(false);
    if (r.student.id === selected) return;
    // Unsaved scores stay as a draft on this computer (marked in the list).
    selectStudent(key, r.student.id);
    setFinished(false);
    setShowList(false);
    if (autoLoad && r.project?.kind === "tm" && r.link?.revision_id) void openSubmission(key, r);
  };

  const next = () => {
    if (!roster) return;
    const all = roster.rows;
    const i = all.findIndex((r) => r.student?.id === selected);
    void i;
    // Next = the oldest hand-in still waiting (grading order), not the next row of the list.
    const after = all.filter((r) => r.state === "submitted" && !isDraftGrade(r) && r.student?.id !== selected).sort(byHandIn)[0];
    if (after) choose(after);
    else setFinished(true);
  };
  /** Previous / next in the list as filtered (the switcher's arrows, ⌥↑/⌥↓). */
  const step = (d: 1 | -1) => {
    const i = rows.findIndex((r) => r.student?.id === selected);
    const n = i < 0 ? rows[0] : rows[i + d];
    if (n) choose(n);
  };

  // The palette commands and their keys (grading/commands.ts) act on this tab.
  const live = useRef({ step, next, focus: () => {} });
  live.current = {
    step,
    next,
    focus: () => {
      if (row && !finished) panelApi.current?.focus();
      else listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    },
  };
  useEffect(
    () =>
      registerGradingController({
        key,
        next: () => live.current.step(1),
        previous: () => live.current.step(-1),
        saveAndNext: () => panelApi.current?.saveAndNext(),
        focusPanel: () => live.current.focus(),
        returnForChanges: () => panelApi.current?.returnForChanges() ?? false,
      }),
    [key],
  );

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
  const draftCount = draftGradeCount(key);
  // Handed in and not graded yet (draft grades wait for "Release", not for grading).
  const waiting = roster.rows.filter((r) => r.state === "submitted" && !isDraftGrade(r)).length;
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.student?.id === (focusId ?? selected)),
  );
  const moveFocus = (i: number) => {
    const r = rows[Math.min(rows.length - 1, Math.max(0, i))];
    if (!r?.student) return;
    setFocusId(r.student.id);
    setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-student="${r.student!.id}"]`)?.focus(), 0);
  };

  return (
    <div className={`tm-grade-page ${row ? "has-selection" : ""}`} data-testid="grading-page">
      <header className="tm-grade-head">
        <div className="tm-assignment-kicker">
          <Codicon name={a.type === "quiz" ? "checklist" : "notebook"} />
          <span>{a.type === "quiz" ? `Coding question · ${a.title}` : "Code assignment"}</span>
          {a.due_date && <span>· due {when(a.due_date)}</span>}
          {a.max_points > 0 && <span>· {a.max_points} points</span>}
        </div>
        <div className="tm-grade-title-row">
          <h1>{a.question ? a.question.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : a.title}</h1>
          {a.type === "quiz" && a.questions.length > 1 && (
            <select className="tm-select" aria-label="Coding question" value={a.question?.id ?? ""} onChange={(e) => openGrading(keyOf("quiz", a.id, Number(e.target.value)))}>
              {a.questions.map((q) => (
                <option key={q.question_id} value={q.question_id}>
                  {q.title}
                </option>
              ))}
            </select>
          )}
          {draftCount > 0 && (
            <button
              type="button"
              className="tm-button tm-button--small"
              data-testid="grade-release-drafts"
              title={a.type === "quiz" ? "Make the draft grades final. Students see them when the quiz results are released." : "Show the draft grades to their students"}
              onClick={async () => {
                const c = await showDialog({
                  message: `Release ${plural(draftCount, "draft grade")}?`,
                  detail: a.type === "quiz" ? "They become final. Students see them when the quiz results are released." : "Students see them in Task Mentor straight away.",
                  buttons: [
                    { id: "release", label: "Release", primary: true },
                    { id: "cancel", label: "Cancel" },
                  ],
                  cancelId: "cancel",
                });
                if (c === "release") await releaseDraftGrades(key);
              }}
            >
              Release {plural(draftCount, "Draft")}
            </button>
          )}
          <button type="button" className="tm-action" title="Refresh from Task Mentor" aria-label="Refresh" onClick={() => void loadRoster(key)}>
            <Codicon name="refresh" />
          </button>
          <button
            type="button"
            className="tm-action"
            title="Open the grading page in Task Mentor"
            aria-label="Open in Task Mentor"
            onClick={() => openGradingInTaskMentor(key, selected ?? null)}
          >
            <Codicon name="link-external" />
          </button>
        </div>
        {/* W9: the way back is a button you can see (the side bar may be folded while reviewing). */}
        {reviewing && (
          <div className="tm-grade-review-bar" role="status" data-testid="grade-review-bar">
            <Codicon name="eye" />
            <span className="tm-grade-review-bar-text">
              Reviewing <b>{reviewing.student}</b>'s submission (read-only)
            </span>
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => void closeReview()} data-testid="grade-close-review" title="Close the review and go back to the folder you had open">
              Close Review
            </button>
          </div>
        )}
        {/* L4: progress once, in one line (the switcher and the side bar don't repeat it). */}
        <p className="tm-grade-progress-line" data-testid="grading-progress" title={`${p.pct}% of submissions graded (students still working are not counted)`}>
          <span className="is-to-grade">
            <b>{p.toGrade}</b> to grade
          </span>
          {" · "}
          <span className="is-graded">
            <b>{p.graded}</b> graded
          </span>
          {" · "}
          <span className="is-in-progress">
            <b>{p.inProgress}</b> in progress
          </span>
          {draftCount > 0 && (
            <>
              {" · "}
              <span>
                <b>{draftCount}</b> draft{draftCount === 1 ? "" : "s"} not released
              </span>
            </>
          )}
        </p>
      </header>

      <div className={`tm-grade-body ${row && !finished ? "has-selection" : ""} ${showList ? "show-list" : ""} ${focusMode && reviewing && row && !finished ? "is-focus" : ""}`}>
        <aside
          className="tm-grade-list"
          aria-label="Students"
          onKeyDown={(e) => {
            if (e.key === "Escape" && showList) {
              e.stopPropagation();
              setShowList(false);
            }
          }}
        >
          <div className="tm-grade-filters" role="tablist" aria-label="Show">
            {(["to-grade", "graded", "working", "not-started", "all"] as Filter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={`tm-filter-chip ${filter === f ? "is-active" : ""}`} onClick={() => setFilter(f)} data-testid={`grade-filter-${f}`}>
                {{ "to-grade": "To grade", graded: "Graded", working: "In progress", "not-started": "Not started", all: "All" }[f]} <span>{counts[f]}</span>
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
            onKeyDown={(e) => {
              // From the row that has the focus (not the student shown), as a list box does.
              const focusedId = (e.target as HTMLElement).closest("[data-student]")?.getAttribute("data-student");
              const at = focusedId ? rows.findIndex((r) => String(r.student?.id) === focusedId) : -1;
              const from = at >= 0 ? at : focusIndex;
              const keys: Record<string, () => void> = {
                ArrowDown: () => moveFocus(from + 1),
                ArrowUp: () => moveFocus(from - 1),
                Home: () => moveFocus(0),
                End: () => moveFocus(rows.length - 1),
                Enter: () => rows[from] && choose(rows[from]),
                " ": () => rows[from] && choose(rows[from]),
              };
              const run = keys[e.key];
              if (!run || e.altKey || e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              run();
            }}
          >
            {rows.length === 0 && (
              <div className="tm-projects-hint">
                <p className="tm-muted">{filter === "to-grade" ? "Nothing waiting to be graded." : "No students here."}</p>
                {filter !== "all" && (
                  <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => setFilter("all")} data-testid="grade-show-all">
                    Show All Students
                  </button>
                )}
              </div>
            )}
            {rows.map((r, i) => {
              const dk = draftKey(key, r.student?.id);
              const unsaved = !!localDrafts[dk];
              const failedSave = failedSaves[dk];
              return (
                <div
                  key={r.student?.id ?? r.project?.id}
                  id={`${ids}-row-${r.student?.id}`}
                  role="option"
                  aria-selected={r.student?.id === selected}
                  tabIndex={i === focusIndex ? 0 : -1}
                  data-student={r.student?.id}
                  className={`tm-grade-row ${r.student?.id === selected ? "is-selected" : ""}`}
                  data-testid="grade-row"
                  onClick={() => choose(r)}
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
                  {isDraftGrade(r) && (
                    <span className="tm-chip is-draft" title="Draft grade: the student doesn't see it yet">
                      Draft
                    </span>
                  )}
                  {r.state === "graded" && r.grade?.score != null && (
                    <span className="tm-chip is-success">
                      {a.max_points > 0 ? `${r.grade.score}/${a.max_points}` : r.grade.score}
                    </span>
                  )}
                  {failedSave ? (
                    <span className="tm-grade-unsaved is-error" role="img" aria-label="Not saved" title={`Not saved: ${failedSave}`} data-testid="grade-row-unsaved">
                      <Codicon name="warning" />
                    </span>
                  ) : (
                    unsaved && (
                      <span className="tm-grade-unsaved" role="img" aria-label="Unsaved changes" title="Unsaved changes (kept on this computer)" data-testid="grade-row-unsaved">
                        <Codicon name="circle-filled" className="tm-grade-draft" />
                      </span>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </aside>
        <main className="tm-grade-main">
          {row && !finished && (
            <div className="tm-grade-switcher" data-testid="grade-switcher">
              <ActionButton icon="chevron-left" label={`Previous student (${formatKeybinding("alt+up", getPlatform().os)})`} disabled={rows.findIndex((r) => r.student?.id === selected) <= 0} onClick={() => step(-1)} />
              <button type="button" className="tm-grade-switcher-who" onClick={() => setShowList(!showList)} aria-expanded={showList} title={showList ? "Hide the list of students" : "Show all students"} data-testid="grade-switcher-toggle">
                <span className={`tm-grade-avatar is-${STATE[row.state].tone}`} aria-hidden>
                  {initials(row.student?.name ?? "?")}
                </span>
                <b>{row.student?.name ?? "Unknown"}</b>
                <span className="tm-muted" data-testid="grade-counter">
                  {queuePos >= 0 ? `${queuePos + 1} of ${queue.length} to grade` : rows.some((r) => r.student?.id === selected) ? `${rows.findIndex((r) => r.student?.id === selected) + 1} of ${rows.length}` : ""}
                </span>
                <Codicon name={showList ? "chevron-up" : "chevron-down"} />
              </button>
              <ActionButton
                icon="chevron-right"
                label={`Next student (${formatKeybinding("alt+down", getPlatform().os)})`}
                disabled={(() => {
                  const i = rows.findIndex((r) => r.student?.id === selected);
                  return i < 0 || i >= rows.length - 1;
                })()}
                onClick={() => step(1)}
              />
            </div>
          )}
          {finished && waiting === 0 ? (
            <div className="tm-view-empty tm-grade-empty tm-grade-finished" data-testid="grade-finished">
              <Codicon name="pass-filled" className="tm-projects-hero" />
              <h3>All handed-in work is graded</h3>
              <p className="tm-muted">
                {p.graded} of {p.submitted} graded{p.inProgress ? ` · ${p.inProgress} still working: their work appears here when they submit` : ""}.
              </p>
              <div className="tm-grade-finished-actions">
                {reviewing && (
                  <button type="button" className="tm-button" onClick={() => void closeReview()}>
                    <Codicon name="home" /> Close Review
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
            <GradePanel key={`${key}:${row.student?.id}`} gkey={key} roster={roster} row={row} onNext={next} apiRef={panelApi} />
          ) : (
            <div className="tm-view-empty tm-grade-empty">
              <Codicon name="person" className="tm-projects-hero" />
              <p>{roster.counts.to_grade ? `Select a student to grade. ${roster.counts.to_grade} submission${roster.counts.to_grade === 1 ? " is" : "s are"} waiting.` : "Select a student to see their work."}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
