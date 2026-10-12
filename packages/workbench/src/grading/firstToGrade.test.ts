import { describe, expect, it } from "vitest";
import { firstToGrade, oldestWaiting, type Roster, type RosterRow } from "./service";

const row = (id: number, state: RosterRow["state"], at: string | null, draft = false): RosterRow =>
  ({ student: { id, name: `S${id}` }, state, project: null, link: null, submitted_at: at, late: false, grade: draft ? { score: 1, rubric_scores: null, feedback: null, graded_at: null, ref_id: 1, status: "draft" } : null }) as RosterRow;
const roster = (rows: RosterRow[]) => ({ rows }) as unknown as Roster;

describe("first submission to grade (W8)", () => {
  it("is the oldest hand-in still waiting (not drafts, not graded, not in progress)", () => {
    const r = roster([row(1, "submitted", "2026-10-12T10:05:00Z"), row(2, "submitted", "2026-10-12T10:01:00Z", true), row(3, "submitted", "2026-10-12T10:03:00Z"), row(4, "graded", "2026-10-12T09:00:00Z"), row(5, "in_progress", null)]);
    expect(firstToGrade(r)?.student?.id).toBe(3);
    expect(firstToGrade(roster([row(4, "graded", null)]))).toBeNull();
    expect(firstToGrade(undefined)).toBeNull();
  });
  it("across practicals: the activity holding the oldest waiting one", () => {
    const rosters = { a: roster([row(1, "submitted", "2026-10-12T10:05:00Z")]), b: roster([row(2, "submitted", "2026-10-12T09:00:00Z")]), c: roster([row(3, "graded", "2026-10-12T08:00:00Z")]) };
    expect(oldestWaiting(rosters, ["a", "b", "c"])).toBe("b");
    expect(oldestWaiting(rosters, ["c"])).toBeNull();
  });
});
