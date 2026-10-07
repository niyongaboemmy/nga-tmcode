import { describe, expect, it } from "vitest";
import { normalizeActivity } from "./matching";

describe("normalizeActivity", () => {
  it("reads Task Mentor's {type, id} shape", () => {
    expect(normalizeActivity({ type: "assignment", id: 31, title: "Calc", course_id: 1, course_name: "Programming", due_date: null, submission_type: "project" })).toEqual({
      activity_type: "assignment",
      activity_id: 31,
      title: "Calc",
      course_id: 1,
      course_name: "Programming",
      due_date: null,
      open: true,
      practical_questions: [],
    });
  });
  it("still reads {activity_type, activity_id}", () => {
    expect(normalizeActivity({ activity_type: "quiz", activity_id: "7", title: "Q" })?.activity_id).toBe(7);
  });
  it("keeps a quiz's TMCode practical questions", () => {
    const a = normalizeActivity({ type: "quiz", id: 78, title: "Q3", practical_questions: [{ question_id: 501, title: "Navbar", points: 10 }, { question_id: "x" }] });
    expect(a?.practical_questions).toEqual([{ question_id: 501, title: "Navbar", points: 10 }]);
  });
  it("drops unknown kinds and bad ids", () => {
    expect(normalizeActivity({ type: "exam", id: 1 })).toBeNull();
    expect(normalizeActivity({ type: "quiz", id: 0 })).toBeNull();
    expect(normalizeActivity({ type: "manual_assessment" })).toBeNull();
  });
});
