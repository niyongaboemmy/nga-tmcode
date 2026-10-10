import { splitFeedback } from "../grading/feedback";

/**
 * An assignment's rubric as the student sees it (S2 "How it's graded"), and
 * after grading the score + note per criterion. Task Mentor stores the rubric
 * as `[{ criteria, description, max_score }]`; older or hand-made rows may say
 * `name`/`title` and `points`, so the shape is read loosely.
 */

export interface RubricCriterion {
  name: string;
  description: string | null;
  max: number;
}

export interface RubricResult extends RubricCriterion {
  score: number | null;
  comment: string;
}

export function normalizeRubric(raw: unknown): RubricCriterion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c, i) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    const name = String(o.criteria ?? o.name ?? o.title ?? "").trim() || `Criterion ${i + 1}`;
    const max = Number(o.max_score ?? o.points ?? o.max ?? 0);
    const description = typeof o.description === "string" && o.description.trim() ? o.description.trim() : null;
    return [{ name, description, max: Number.isFinite(max) && max > 0 ? max : 0 }];
  });
}

export const rubricTotal = (r: RubricCriterion[]) => r.reduce((n, c) => n + c.max, 0);

/**
 * Per-criterion results: `rubric_scores` when Task Mentor sends them (newer
 * servers, graded and released), else the notes parsed from the "Criteria
 * notes" block of the feedback (scores unknown). `feedback` is the teacher's
 * own text without that block when it was parsed; null `results` when there
 * is nothing per criterion to show.
 */
export function rubricResults(
  criteria: RubricCriterion[],
  my: { rubric_scores?: { index: number; score: number; comment?: string | null }[] | null; feedback: string | null } | null | undefined,
): { results: RubricResult[] | null; feedback: string | null } {
  const feedback = my?.feedback ?? null;
  if (!criteria.length || !my) return { results: null, feedback };
  const split = splitFeedback(feedback, criteria.map((c) => c.name));
  const scores = Array.isArray(my.rubric_scores) ? my.rubric_scores : null;
  if (scores && scores.length) {
    const byIndex = new Map(scores.map((s) => [s.index, s]));
    const results = criteria.map((c, i) => {
      const s = byIndex.get(i);
      return { ...c, score: s && Number.isFinite(Number(s.score)) ? Number(s.score) : null, comment: (s?.comment ?? "").trim() || split.comments[i] || "" };
    });
    // The block repeats the notes shown in the table: the teacher's own words are enough above it.
    return { results, feedback: split.feedback.trim() || null };
  }
  if (split.comments.some((c) => c)) {
    return { results: criteria.map((c, i) => ({ ...c, score: null, comment: split.comments[i] })), feedback: split.feedback.trim() || null };
  }
  return { results: null, feedback };
}
