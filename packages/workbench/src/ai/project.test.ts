import { describe, expect, it } from "vitest";
import { aiProjectOf } from "./project";

const binding = { project_id: 7, kind: "tm" as const };

describe("aiProjectOf", () => {
  it("no folder binding: no project", () => {
    expect(aiProjectOf(null, null)).toEqual({ id: null, assessment: false });
  });

  it("a bound project before Task Mentor answers: its id, not known to be an assessment", () => {
    expect(aiProjectOf(binding, null)).toEqual({ id: 7, assessment: false });
  });

  it("an assignment's workspace, a linked project, or one the assignment list names is an assessment", () => {
    expect(aiProjectOf(binding, { id: 7, assignment: { id: 3, title: "A", status: "published" }, links: undefined }).assessment).toBe(true);
    expect(aiProjectOf(binding, { id: 7, assignment: null, links: { total: 1, submitted: 0, items: [] } }).assessment).toBe(true);
    expect(aiProjectOf(binding, { id: 7, assignment: null, links: [] }).assessment).toBe(false);
    expect(aiProjectOf(binding, null, { student: [{ my: { project_id: 7 } }, { my: null }] }).assessment).toBe(true);
    expect(aiProjectOf(binding, null, { student: [{ my: { project_id: 8 } }] }).assessment).toBe(false);
  });

  it("ignores another project's details", () => {
    expect(aiProjectOf(binding, { id: 9, assignment: { id: 3, title: "A", status: "published" }, links: undefined })).toEqual({ id: 7, assessment: false });
  });
});
