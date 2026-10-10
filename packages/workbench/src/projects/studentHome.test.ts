import { describe, expect, it } from "vitest";
import { useWorkbench } from "../state/store";
import { announceChanges, type AssignmentSummary } from "./assignments";
import { dayLabel, isAssessmentWorkspace, practicalStateOf, todoSummary } from "./studentHome";
import type { Project } from "./types";

const a = (id: number, over: Partial<AssignmentSummary> = {}): AssignmentSummary => ({
  id,
  title: `A${id}`,
  kind: "practical",
  course_id: 1,
  course_name: "Web",
  status: "published",
  due_date: null,
  points: 20,
  language: null,
  read_only: false,
  late: false,
  my: { project_id: null, link_id: null, state: "not_started", submitted_at: null, revision_number: null, grade: null, max_points: null, feedback: null },
  ...over,
});
const NOW = new Date(2026, 9, 7, 12, 0).getTime(); // Wed 7 Oct 2026
const at = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe("todoSummary", () => {
  it("counts what is left and names the next due day", () => {
    expect(todoSummary([a(1, { due_date: at(2) }), a(2, { due_date: at(-1) })], NOW)).toMatch(/^2 to do · next due \S+$/);
    expect(todoSummary([a(1, { due_date: at(1) })], NOW)).toBe("1 to do · next due tomorrow");
    expect(todoSummary([a(1, { due_date: at(-1) })], NOW)).toBe("1 to do · 1 overdue");
    expect(todoSummary([a(1, { read_only: true }), a(2, { my: { ...a(0).my!, state: "submitted" } })], NOW)).toBe("Nothing due");
    expect(todoSummary(null, NOW)).toBe("Nothing due");
  });
  it("says today, tomorrow, a weekday, then a date", () => {
    expect(dayLabel(NOW + 3_600_000, NOW)).toBe("today");
    expect(dayLabel(NOW + 86_400_000, NOW)).toBe("tomorrow");
    expect(dayLabel(NOW + 2 * 86_400_000, NOW)).toBe(new Date(NOW + 2 * 86_400_000).toLocaleDateString([], { weekday: "short" }));
    expect(dayLabel(NOW + 10 * 86_400_000, NOW)).toBe(new Date(NOW + 10 * 86_400_000).toLocaleDateString([], { day: "numeric", month: "short" }));
  });
});

const project = (id: number, over: Partial<Project> = {}) => ({ id, name: `P${id}`, status: "draft", links: [], ...over }) as unknown as Project;

describe("practicalStateOf", () => {
  const link = (status: "linked" | "submitted") => [{ id: 1, activity_type: "quiz", activity_id: 78, question_id: 501, status }];
  it("finds the student's project for a quiz practical question", () => {
    expect(practicalStateOf(78, 501, [], null).state).toBe("not_started");
    expect(practicalStateOf(78, 501, [project(5, { links: link("linked") as never })], null).state).toBe("in_progress");
    expect(practicalStateOf(78, 501, [project(5, { links: { total: 1, submitted: 1, items: link("submitted") } as never })], null).state).toBe("submitted");
    expect(practicalStateOf(78, 501, [project(5, { status: "graded", links: link("submitted") as never })], null).state).toBe("graded");
    // Another question of the same quiz is not this one.
    expect(practicalStateOf(78, 502, [project(5, { links: link("linked") as never })], null).state).toBe("not_started");
  });
  it("prefers the open project (it follows submits first)", () => {
    const stale = project(5, { links: link("linked") as never });
    const fresh = project(5, { status: "submitted", links: link("submitted") as never });
    expect(practicalStateOf(78, 501, [stale], fresh).state).toBe("submitted");
  });
});

describe("isAssessmentWorkspace", () => {
  it("is an assignment workspace or a quiz practical, when bound", () => {
    expect(isAssessmentWorkspace(project(1, { assignment: { id: 51, title: "x", status: "published" } }), true)).toBe(true);
    expect(isAssessmentWorkspace(project(1, { links: [{ id: 1, activity_type: "quiz", activity_id: 78, question_id: 501, status: "linked" }] as never }), true)).toBe(true);
    expect(isAssessmentWorkspace(project(1), true)).toBe(false);
    expect(isAssessmentWorkspace(project(1, { assignment: { id: 51, title: "x", status: "published" } }), false)).toBe(false);
  });
});

describe("announceChanges", () => {
  it("tells new work and new grades once, never on the first load", () => {
    const toasts = () => useWorkbench.getState().notifications.map((n) => n.message);
    const before = toasts().length;
    announceChanges(null, [a(901)]);
    expect(toasts().length).toBe(before);
    announceChanges([a(901)], [a(901), a(902, { title: "Weather app" })]);
    expect(toasts()).toContain("New assignment: Weather app");
    const graded = a(901, { title: "Calc", my: { ...a(0).my!, state: "graded", grade: 17, max_points: 20 } });
    announceChanges([a(901)], [graded]);
    announceChanges([a(901)], [graded]);
    expect(toasts().filter((m) => m === "Calc was graded: 17/20")).toHaveLength(1);
  });
});
