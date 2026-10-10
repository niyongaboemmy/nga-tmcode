import { describe, expect, it } from "vitest";
import { normalizeRubric, rubricResults, rubricTotal } from "./rubric";

const rubric = normalizeRubric([
  { criteria: "Adding items works", description: "Typing a task and pressing Add shows it", max_score: 12 },
  { criteria: "Code quality", description: null, max_score: 8 },
]);

describe("rubric in the brief", () => {
  it("reads Task Mentor's rubric (and loose shapes), with a total", () => {
    expect(rubric).toEqual([
      { name: "Adding items works", description: "Typing a task and pressing Add shows it", max: 12 },
      { name: "Code quality", description: null, max: 8 },
    ]);
    expect(rubricTotal(rubric)).toBe(20);
    expect(normalizeRubric([{ name: "Layout", points: "5" }, null, { title: "" }])).toEqual([
      { name: "Layout", description: null, max: 5 },
      { name: "Criterion 3", description: null, max: 0 },
    ]);
    expect(normalizeRubric(null)).toEqual([]);
    expect(normalizeRubric("x")).toEqual([]);
  });

  it("per-criterion scores and notes from rubric_scores", () => {
    const r = rubricResults(rubric, {
      rubric_scores: [
        { index: 0, score: 10, comment: "Works, but empty tasks are added" },
        { index: 1, score: 7, comment: null },
      ],
      feedback: "Good work\n\nCriteria notes:\n• Adding items works: Works, but empty tasks are added",
    });
    expect(r.results?.map((x) => [x.name, x.score, x.comment])).toEqual([
      ["Adding items works", 10, "Works, but empty tasks are added"],
      ["Code quality", 7, ""],
    ]);
    expect(r.feedback).toBe("Good work");
  });

  it("an older Task Mentor: notes parsed from the Criteria notes block, scores unknown", () => {
    const r = rubricResults(rubric, { feedback: "Nice\n\nCriteria notes:\n• Code quality: clear names" });
    expect(r.results?.map((x) => [x.score, x.comment])).toEqual([
      [null, ""],
      [null, "clear names"],
    ]);
    expect(r.feedback).toBe("Nice");
  });

  it("nothing per criterion: the feedback as it is", () => {
    expect(rubricResults(rubric, { feedback: "Well done", rubric_scores: null })).toEqual({ results: null, feedback: "Well done" });
    expect(rubricResults([], { feedback: "x" })).toEqual({ results: null, feedback: "x" });
  });
});
