/**
 * Quick scores and score checks for the grade panel, the same rules as Task
 * Mentor's web grading page (PracticalGradingPage quickScores).
 */

export interface QuickScore {
  label: string;
  value: number;
  title: string;
}

export interface Level {
  label: string;
  score: number;
}

const half = (n: number) => Math.round(n * 2) / 2;

/**
 * Per-rubric levels when the criterion has them; otherwise every value for a
 * small whole-number maximum (0…6), else 0 / ¼ / ½ / ¾ / full.
 */
export function quickScores(max: number, levels?: Level[] | null): QuickScore[] {
  if (levels?.length) return levels.map((l) => ({ label: String(l.score), value: l.score, title: l.label }));
  if (Number.isInteger(max) && max > 0 && max <= 6) {
    return Array.from({ length: max + 1 }, (_, v) => ({ label: String(v), value: v, title: v === 0 ? "Not met" : v === max ? "Fully met" : `${v} of ${max}` }));
  }
  const q = (f: number) => half(max * f);
  const all: QuickScore[] = [
    { label: "0", value: 0, title: "Not met" },
    { label: String(q(0.25)), value: q(0.25), title: "¼: a little met" },
    { label: String(q(0.5)), value: q(0.5), title: "½: partly met" },
    { label: String(q(0.75)), value: q(0.75), title: "¾: mostly met" },
    { label: String(max), value: max, title: "Fully met" },
  ];
  // Tiny maximums give repeated values (¼ of 1 = 0.5 = ½ of 1).
  return all.filter((s, i) => all.findIndex((x) => x.value === s.value) === i);
}

/** A typed score kept within 0…max; `clamped` says the typed value was changed. */
export function clampScore(raw: string, max: number): { value: number | null; clamped: boolean } {
  if (raw.trim() === "") return { value: null, clamped: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: null, clamped: true };
  // No maximum (0): only the lower bound applies.
  const v = Math.max(0, max > 0 ? Math.min(max, n) : n);
  return { value: v, clamped: v !== n };
}

/**
 * The grading form's criteria and maximum, as Task Mentor sent them but usable: criteria without a
 * name or marks are dropped, so an assignment with no (real) criteria is graded with one final grade.
 * The maximum falls back to the criteria's sum; 0 means "no maximum given".
 */
export function normaliseGrading<A extends { rubric?: unknown; max_points?: unknown }>(a: A): Omit<A, "rubric" | "max_points"> & { rubric: { criteria: string; max_score: number }[]; max_points: number } {
  const raw = Array.isArray(a.rubric) ? (a.rubric as { criteria?: unknown; max_score?: unknown }[]) : [];
  const rubric = raw
    .map((c) => ({ ...c, criteria: String(c?.criteria ?? "").trim(), max_score: Number(c?.max_score) || 0 }))
    .filter((c) => c.criteria && c.max_score > 0);
  const given = Number(a.max_points);
  const max_points = given > 0 ? given : rubric.reduce((n, c) => n + c.max_score, 0);
  return { ...a, rubric, max_points };
}

/** "The criteria add up to 18, but the activity is worth 20 points." (null when they match). */
export function rubricMismatch(rubric: { max_score: number }[], points: number): string | null {
  if (!rubric.length) return null;
  const sum = rubric.reduce((n, c) => n + c.max_score, 0);
  if (Math.abs(sum - points) < 1e-9) return null;
  return `The criteria add up to ${sum}, but the activity is worth ${points} points.`;
}
