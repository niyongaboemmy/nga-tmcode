import { describe, expect, it } from "vitest";
import type { AssignmentSummary } from "./assignments";
import { deriveStatus, resolveStatus, type StudentStatus } from "./status";
import type { Project } from "./types";

type MyState = "not_started" | "in_progress" | "submitted" | "graded";
type ProjectStatus = "draft" | "submitted" | "graded" | "removed" | undefined;

const assignment = (o: { my?: MyState | null; returned?: boolean; accepts?: boolean | undefined; readOnly?: boolean }): AssignmentSummary => ({
  id: 51,
  title: "Build a to-do list",
  kind: "practical",
  course_id: 3,
  course_name: "Web Development",
  status: o.readOnly ? "completed" : "published",
  due_date: null,
  points: 20,
  language: "javascript",
  read_only: !!o.readOnly,
  late: false,
  my:
    o.my === null
      ? null
      : {
          project_id: o.my && o.my !== "not_started" ? 140 : null,
          link_id: o.my && o.my !== "not_started" ? 9 : null,
          state: o.my ?? "not_started",
          submitted_at: null,
          revision_number: null,
          grade: o.my === "graded" ? 17 : null,
          max_points: 20,
          feedback: null,
          returned_at: o.returned ? "2026-10-12T10:00:00Z" : null,
          returned_message: o.returned ? "Add a delete button." : null,
        },
  ...(o.accepts === undefined ? {} : { accepts_submissions: o.accepts }),
});
const project = (status: ProjectStatus): Project | null => (status === undefined ? null : ({ id: 140, name: "todo", status } as unknown as Project));

describe("resolveStatus: the cases the review found (W4)", () => {
  const cases: [string, Parameters<typeof assignment>[0], ProjectStatus, StudentStatus, boolean][] = [
    ["nothing yet", { my: "not_started" }, undefined, "not_started", false],
    ["older server, no my", { my: null }, undefined, "not_started", false],
    ["working", { my: "in_progress" }, "draft", "in_progress", false],
    ["just started here, list not refreshed", { my: "not_started" }, "draft", "in_progress", true],
    ["submitted, both agree", { my: "submitted" }, "submitted", "submitted", false],
    ["just submitted here, list not refreshed", { my: "in_progress" }, "submitted", "submitted", true],
    ["withdrawn here, list not refreshed", { my: "submitted" }, "draft", "in_progress", true],
    ["returned, project still says submitted (s10)", { my: "in_progress", returned: true }, "submitted", "returned", true],
    ["returned, both caught up", { my: "in_progress", returned: true }, "draft", "returned", false],
    ["graded, project still says submitted (s11)", { my: "graded" }, "submitted", "graded", true],
    ["graded, both agree", { my: "graded" }, "graded", "graded", false],
    ["project graded first", { my: "submitted" }, "graded", "graded", true],
    ["closed by the teacher, not handed in", { my: "in_progress", accepts: false }, "draft", "closed", false],
    ["closed, returned work can't come back", { my: "in_progress", returned: true, accepts: false }, "draft", "closed", false],
    ["submitted, then closed: still submitted", { my: "submitted", accepts: false }, "submitted", "submitted", false],
    ["completed (read-only), not graded", { my: "submitted", readOnly: true }, "submitted", "closed", false],
    ["completed after grading: the grade stays visible", { my: "graded", readOnly: true }, "graded", "graded", false],
    ["submitted again after a return", { my: "submitted", returned: true }, "submitted", "submitted", false],
  ];
  it.each(cases)("%s", (_name, a, ps, status, syncing) => {
    expect(resolveStatus(assignment(a), project(ps))).toEqual({ status, syncing });
  });
});

describe("deriveStatus: every combination", () => {
  const mys: (MyState | null)[] = [null, "not_started", "in_progress", "submitted", "graded"];
  const projects: ProjectStatus[] = [undefined, "draft", "submitted", "graded", "removed"];
  const all: { a: AssignmentSummary; p: Project | null; here: boolean; label: string }[] = [];
  for (const my of mys)
    for (const ps of projects)
      for (const returned of [false, true])
        for (const accepts of [undefined, true, false])
          for (const readOnly of [false, true])
            for (const here of [false, true]) all.push({ a: assignment({ my, returned, accepts, readOnly }), p: project(ps), here, label: `${my}/${ps}/r${+returned}/a${accepts}/ro${+readOnly}/h${+here}` });

  it("covers the whole space", () => expect(all.length).toBe(5 * 5 * 2 * 3 * 2 * 2));

  it("gives exactly one status and at most one primary button, never a second Submit", () => {
    for (const { a, p, here, label } of all) {
      const v = deriveStatus(a, p, { here });
      expect(["not_started", "in_progress", "submitted", "returned", "graded", "closed"], label).toContain(v.status);
      const ids = [v.primary?.id, ...v.secondary.map((s) => s.id)].filter(Boolean);
      expect(new Set(ids).size, label).toBe(ids.length);
      expect(v.secondary.some((s) => s.id === "submit"), label).toBe(false);
    }
  });

  it("follows the assignment for grades, and the project only when it is open here", () => {
    for (const { a, p, here, label } of all) {
      const v = deriveStatus(a, p, { here });
      if (a.my?.state === "graded") expect(v.status, label).toBe("graded");
      if (!here) expect(v.syncing, label).toBe(false);
      if (!here) expect(v.status, label).toBe(resolveStatus(a, null).status);
    }
  });

  it("never offers Submit or Start on work that is closed, handed in or graded", () => {
    for (const { a, p, here, label } of all) {
      const v = deriveStatus(a, p, { here });
      if (v.status === "closed" || v.status === "submitted" || v.status === "graded") expect(["submit", "start", "save"], label).not.toContain(v.primary?.id);
      if (v.primary?.id === "submit") expect(here && (v.status === "in_progress" || v.status === "returned"), label).toBe(true);
      if (v.primary?.id === "withdraw") expect(here && v.status === "submitted", label).toBe(true);
    }
  });

  it("names the buttons in the glossary's words", () => {
    const a = assignment({ my: "in_progress", returned: true });
    expect(deriveStatus(a, project("draft"), { here: true })).toMatchObject({ status: "returned", headline: "Returned by your teacher", primary: { id: "submit", label: "Submit Again" }, secondary: [{ label: "Save to Task Mentor" }, { label: "Open in Task Mentor" }] });
    expect(deriveStatus(a, null, { here: false }).primary).toEqual({ id: "continue", label: "Continue" });
    expect(deriveStatus(assignment({ my: "submitted" }), project("submitted"), { here: true }).primary?.label).toBe("Withdraw to Edit");
    expect(deriveStatus(assignment({ my: "not_started" }), null, { here: false }).primary?.label).toBe("Start");
    expect(deriveStatus(assignment({ my: "graded" }), null, { here: false }).primary?.label).toBe("View Feedback");
    expect(deriveStatus(assignment({ my: "in_progress" }), project("draft"), { here: true }).headline).toBe("You're working on it in this window");
  });
});
