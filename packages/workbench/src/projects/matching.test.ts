import { describe, expect, it } from "vitest";
import { assessmentItems, dueText, normalizeActivity } from "./matching";
import type { LinkableActivity } from "./types";

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

describe("assessmentItems (one list to pick from)", () => {
  const day = 86_400_000;
  const iso = (d: number) => new Date(Date.now() + d * day).toISOString();
  const list: LinkableActivity[] = [
    { activity_type: "assignment", activity_id: 2, title: "Later", course_name: "Web", due_date: iso(5), open: true },
    { activity_type: "assignment", activity_id: 1, title: "Soon", course_name: "Web", due_date: iso(1.5), open: true },
    { activity_type: "assignment", activity_id: 3, title: "Closed", course_name: "Web", due_date: iso(-1), open: false },
    { activity_type: "quiz", activity_id: 78, title: "Quiz 3", course_name: "Web", due_date: iso(2.5), open: true, practical_questions: [{ question_id: 501, title: "Navbar", points: 10 }] },
    { activity_type: "manual_assessment", activity_id: 9, title: "Lab", course_name: "Algebra", due_date: null, open: true },
  ];

  it("groups by subject, soonest due first, closed last, with a quiz's practical before the whole quiz", () => {
    const items = assessmentItems(list);
    expect(items.map((i) => i.label)).toEqual(["Lab", "Soon", "Navbar", "Quiz 3", "Later", "Closed"]);
    expect(items.filter((i) => i.separator).map((i) => i.separator)).toEqual(["Algebra", "Web"]);
    expect(items.find((i) => i.label === "Navbar")).toMatchObject({ id: "quiz:78:501", description: "Quiz practical · Quiz 3 · 10 points · Web" });
    expect(items.find((i) => i.label === "Quiz 3")?.description).toBe("Whole quiz · Web");
    expect(items.find((i) => i.label === "Closed")?.detail).toBe("closed");
    expect(items.find((i) => i.label === "Soon")?.detail).toMatch(/· (tomorrow|2 days left)$/);
  });

  it("marks the current assessment (and the current practical question)", () => {
    expect(assessmentItems(list, { activity_type: "assignment", activity_id: 2 }).find((i) => i.label === "Later")?.description).toContain("current");
    const q = assessmentItems(list, { activity_type: "quiz", activity_id: 78, question_id: 501 });
    expect(q.find((i) => i.label === "Navbar")?.description).toContain("current");
    expect(q.find((i) => i.label === "Quiz 3")?.description).not.toContain("current");
  });

  it("dueText", () => {
    expect(dueText(null)).toBe("");
    expect(dueText(iso(3), false)).toBe("closed");
    expect(dueText(iso(-2))).toMatch(/^was due /);
    expect(dueText(iso(0.2))).toMatch(/· today$/);
  });
});
