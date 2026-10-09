import { describe, expect, it } from "vitest";
import { splitFeedback } from "./feedback";

describe("splitFeedback", () => {
  it("takes the criteria notes out of the feedback, by criterion", () => {
    const r = splitFeedback("Good work\n\nCriteria notes:\n• Code quality: tidy\n• Code: short", ["Code", "Code quality"]);
    expect(r.feedback).toBe("Good work");
    expect(r.comments).toEqual(["short", "tidy"]);
  });

  it("reads a block with no teacher text, unnamed criteria and notes over several lines", () => {
    const r = splitFeedback("Criteria notes:\n• Criterion 2: first line\nsecond line", ["Layout", ""]);
    expect(r.feedback).toBe("");
    expect(r.comments).toEqual(["", "first line\nsecond line"]);
  });

  it("leaves feedback without a block as it is", () => {
    expect(splitFeedback("Nice", ["A"])).toEqual({ feedback: "Nice", comments: [""] });
    expect(splitFeedback(null, [])).toEqual({ feedback: "", comments: [] });
  });
});
