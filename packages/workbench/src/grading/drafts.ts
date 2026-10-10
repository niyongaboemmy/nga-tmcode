import { create } from "zustand";
import { splitFeedback } from "./feedback";
import type { Annotation, GradeInput, Roster, RosterRow } from "./service";

/**
 * Unsaved grades ("drafts" on this computer, not Task Mentor's draft grades):
 * kept per activity and student in localStorage, so they survive closing the
 * tab, loading another review folder and quitting TMCode. A failed save is
 * remembered too, for the roster's "not saved" mark.
 */

export interface Draft {
  scores: (number | null)[];
  comments: string[];
  score: number | null;
  feedback: string;
  annotations: Annotation[];
  /** The grade's version when editing began (null: no grade then), to spot another teacher's save. */
  base?: string | null;
}

interface DraftsState {
  drafts: Record<string, Draft>;
  /** Failed saves: draft key → message. */
  failed: Record<string, string>;
}

const STORAGE_KEY = "tmcode.grading.drafts";

function load(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Draft>) : {};
    for (const d of Object.values(parsed)) d.annotations ??= [];
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist(drafts: Record<string, Draft>) {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage full or blocked: the draft still lives in this window.
  }
}

export const useDrafts = create<DraftsState>(() => ({ drafts: load(), failed: {} }));

export const draftKey = (gkey: string, studentId: number | null | undefined) => `${gkey}:${studentId ?? ""}`;

/** The form as Task Mentor has it now. */
export function draftFrom(roster: Roster, row: RosterRow): Draft {
  const rubric = roster.activity.rubric;
  const g = row.grade;
  const scores = rubric.map((_, i) => g?.rubric_scores?.find((s) => s.index === i)?.score ?? null);
  // Feedback composed by Task Mentor carries "Criteria notes:"; edit only the teacher's part (the server adds the notes again).
  const split = splitFeedback(g?.feedback, rubric.map((c) => c.criteria));
  // Servers that keep a comment per score send it; older ones only have the notes block.
  const kept = g?.rubric_scores?.some((s) => s.comment?.trim());
  const comments = kept ? rubric.map((_, i) => g?.rubric_scores?.find((s) => s.index === i)?.comment ?? "") : split.comments;
  const annotations = (g?.annotations ?? []).map((a) => ({ path: a.path, line: a.line, text: a.text }));
  return { scores, comments, score: rubric.length ? null : (g?.score ?? null), feedback: split.feedback, annotations };
}

/** Draft content only (no bookkeeping), for comparing with the server's. */
const content = (d: Draft) => JSON.stringify({ scores: d.scores, comments: d.comments, score: d.score, feedback: d.feedback, annotations: d.annotations });

export function sameContent(a: Draft, b: Draft) {
  return content(a) === content(b);
}

export function getDraft(dkey: string): Draft | undefined {
  return useDrafts.getState().drafts[dkey];
}

/**
 * Stores the form for this student; equal to Task Mentor's (`pristine`) means
 * nothing unsaved, so the draft goes. The first edit records the version it
 * started from.
 */
export function putDraft(dkey: string, d: Draft, pristine: Draft, version: string | null | undefined) {
  const drafts = { ...useDrafts.getState().drafts };
  if (sameContent(d, pristine)) delete drafts[dkey];
  else {
    const prev = drafts[dkey];
    drafts[dkey] = { ...d, base: prev ? prev.base : (version ?? null) };
  }
  useDrafts.setState({ drafts });
  persist(drafts);
}

export function dropDraft(dkey: string) {
  const drafts = { ...useDrafts.getState().drafts };
  if (!(dkey in drafts)) return;
  delete drafts[dkey];
  useDrafts.setState({ drafts });
  persist(drafts);
}

/** After "Keep Mine": the draft now answers the version the teacher has seen. */
export function rebaseDraft(dkey: string, version: string | null) {
  const d = getDraft(dkey);
  if (!d) return;
  const drafts = { ...useDrafts.getState().drafts, [dkey]: { ...d, base: version } };
  useDrafts.setState({ drafts });
  persist(drafts);
}

export function setFailed(dkey: string, message: string | null) {
  const failed = { ...useDrafts.getState().failed };
  if (message) failed[dkey] = message;
  else delete failed[dkey];
  useDrafts.setState({ failed });
}

/** The PUT body's grading part (scores, notes, feedback, line comments). */
export function inputFromDraft(roster: Roster, d: Draft): GradeInput {
  const rubric = roster.activity.rubric;
  return {
    rubric_scores: rubric.map((_, i) => ({ index: i, score: d.scores[i] ?? 0, comment: d.comments[i]?.trim() || null })),
    score: rubric.length ? null : d.score,
    feedback: d.feedback,
    annotations: d.annotations.filter((a) => a.text.trim()).map((a) => ({ path: a.path, line: a.line, text: a.text.trim() })),
  };
}

/** The form for a student: the unsaved draft, else Task Mentor's grade. */
export function currentDraft(roster: Roster | undefined, gkey: string, studentId: number): Draft | null {
  const d = getDraft(draftKey(gkey, studentId));
  if (d) return d;
  const row = roster?.rows.find((r) => r.student?.id === studentId);
  return roster && row ? draftFrom(roster, row) : null;
}
