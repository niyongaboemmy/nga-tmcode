import { describe, expect, it } from "vitest";
import { dueLabel, groupAssignments, handedInLate, parseAssignmentLink, returnedForChanges, type AssignmentSummary } from "./assignments";

const a = (id: number, over: Partial<AssignmentSummary> = {}): AssignmentSummary => ({
  id,
  title: `A${id}`,
  kind: "practical",
  course_id: 1,
  course_name: "Web",
  status: "published",
  due_date: null,
  points: 10,
  language: null,
  read_only: false,
  late: false,
  my: { project_id: null, link_id: null, state: "not_started", submitted_at: null, revision_number: null, grade: null, max_points: null, feedback: null },
  ...over,
});
const my = (state: NonNullable<AssignmentSummary["my"]>["state"]) => ({ ...a(0).my!, state });

describe("assignments", () => {
  it("parses tmcode://assignment links and rejects others", () => {
    expect(parseAssignmentLink("tmcode://assignment?id=12&api=https://taskmentor-api.amashuri.com/")).toEqual({ id: 12, api: "https://taskmentor-api.amashuri.com" });
    expect(parseAssignmentLink("tmcode://project?id=12&api=x")).toBeNull();
    expect(parseAssignmentLink("tmcode://assignment?id=abc")).toBeNull();
    expect(parseAssignmentLink("https://assignment?id=1")).toBeNull();
    expect(parseAssignmentLink("not a url")).toBeNull();
  });

  it("labels due dates", () => {
    const now = Date.parse("2026-10-07T10:00:00Z");
    expect(dueLabel(null, now)).toBeNull();
    expect(dueLabel("2026-10-10T10:00:00Z", now)).toEqual({ text: "3 days left", tone: "ok" });
    expect(dueLabel("2026-10-07T15:00:00Z", now)).toEqual({ text: "5 h left", tone: "soon" });
    expect(dueLabel("2026-10-07T10:20:00Z", now)).toEqual({ text: "20 min left", tone: "soon" });
    expect(dueLabel("2026-10-05T10:00:00Z", now)).toEqual({ text: "2 days late", tone: "late" });
  });

  it("groups by state, completed first wins, to-do sorted by due date", () => {
    const g = groupAssignments([
      a(1, { due_date: "2026-10-20T00:00:00Z" }),
      a(2, { due_date: "2026-10-09T00:00:00Z", my: my("in_progress") }),
      a(3, { my: my("submitted") }),
      a(4, { my: my("graded") }),
      a(5, { read_only: true, status: "completed", my: my("submitted") }),
      a(6, { my: null }),
    ]);
    expect(g.todo.map((x) => x.id)).toEqual([2, 1, 6]);
    expect(g.submitted.map((x) => x.id)).toEqual([3]);
    expect(g.graded.map((x) => x.id)).toEqual([4]);
    expect(g.completed.map((x) => x.id)).toEqual([5]);
  });

  it("late comes from the submission when Task Mentor sends it, else from the due date", () => {
    expect(handedInLate(a(1, { late: true, my: { ...my("submitted"), is_late: false } }))).toBe(false);
    expect(handedInLate(a(1, { late: false, my: { ...my("submitted"), is_late: true } }))).toBe(true);
    expect(handedInLate(a(1, { late: true, my: { ...my("in_progress"), is_late: null } }))).toBe(false);
    expect(handedInLate(a(1, { late: true, my: my("submitted") }))).toBe(true);
  });

  it("returned work shows only while it is back in progress", () => {
    const back = { ...my("in_progress"), returned_at: "2026-10-09T10:00:00Z", returned_message: "Fix the list" };
    expect(returnedForChanges(a(1, { my: back }))).toBe(true);
    expect(returnedForChanges(a(1, { my: { ...back, state: "submitted" } }))).toBe(false);
    expect(returnedForChanges(a(1, { my: back, read_only: true }))).toBe(false);
    expect(returnedForChanges(a(1, { my: my("in_progress") }))).toBe(false);
  });
});
