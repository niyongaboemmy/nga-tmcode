import { describe, expect, it } from "vitest";
import { compareManifests } from "./diff";
import { clampScore, normaliseGrading, quickScores, rubricMismatch } from "./scoring";

describe("quick scores", () => {
  it("lists every value for a small whole maximum", () => {
    expect(quickScores(4).map((q) => q.value)).toEqual([0, 1, 2, 3, 4]);
  });
  it("uses quarters (to the half point) for bigger maximums, like the web", () => {
    expect(quickScores(12).map((q) => q.value)).toEqual([0, 3, 6, 9, 12]);
    expect(quickScores(10).map((q) => q.value)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
  it("drops repeated values and prefers rubric levels", () => {
    expect(quickScores(0.5).map((q) => q.value)).toEqual([0, 0.5]);
    expect(quickScores(10, [{ label: "Good", score: 7 }, { label: "Great", score: 10 }]).map((q) => [q.value, q.title])).toEqual([
      [7, "Good"],
      [10, "Great"],
    ]);
  });
});

describe("score checks", () => {
  it("clamps typed values and says so", () => {
    expect(clampScore("15", 12)).toEqual({ value: 12, clamped: true });
    expect(clampScore("-1", 12)).toEqual({ value: 0, clamped: true });
    expect(clampScore("6", 12)).toEqual({ value: 6, clamped: false });
    expect(clampScore("", 12)).toEqual({ value: null, clamped: false });
  });
  it("warns when the rubric total is not the activity's points", () => {
    expect(rubricMismatch([{ max_score: 12 }, { max_score: 8 }], 20)).toBeNull();
    expect(rubricMismatch([{ max_score: 12 }, { max_score: 6 }], 20)).toBe("The criteria add up to 18, but the activity is worth 20 points.");
    expect(rubricMismatch([], 20)).toBeNull();
  });
});

describe("changed files", () => {
  it("lists added, modified and deleted paths", () => {
    const f = (path: string, sha: string) => ({ path, sha256: sha, size: 1 });
    expect(compareManifests([f("a.js", "1"), f("b.js", "2"), f("gone.txt", "3")], [f("a.js", "1"), f("b.js", "9"), f("new.css", "4")])).toEqual([
      { path: "b.js", status: "modified" },
      { path: "gone.txt", status: "deleted" },
      { path: "new.css", status: "added" },
    ]);
  });
});

describe("no criteria: one final grade", () => {
  it("drops unusable criteria, so the activity is graded with one final grade", () => {
    expect(normaliseGrading({ rubric: null, max_points: 20 })).toMatchObject({ rubric: [], max_points: 20 });
    expect(normaliseGrading({ rubric: [{ criteria: " ", max_score: 5 }, { criteria: "Works", max_score: 0 }], max_points: 10 }).rubric).toEqual([]);
    expect(normaliseGrading({ rubric: [{ criteria: "Works", max_score: 6 }], max_points: 6 }).rubric).toHaveLength(1);
  });

  it("the maximum falls back to the criteria's sum; 0 means no maximum", () => {
    expect(normaliseGrading({ rubric: [{ criteria: "A", max_score: 4 }, { criteria: "B", max_score: 6 }], max_points: 0 }).max_points).toBe(10);
    expect(normaliseGrading({ rubric: [], max_points: null }).max_points).toBe(0);
  });

  it("with no maximum, a score is only kept at 0 or more", () => {
    expect(clampScore("87", 0)).toEqual({ value: 87, clamped: false });
    expect(clampScore("-3", 0)).toEqual({ value: 0, clamped: true });
    expect(clampScore("25", 20)).toEqual({ value: 20, clamped: true });
  });
});
