import { describe, expect, it } from "vitest";
import { resolveRole, useRole, whenRoleResolved, type RoleInputs } from "./role";

const base: RoleInputs = { signedIn: true, staff: null, assignmentsChecked: false, gradingChecked: false, grader: false, studentWork: false, cached: null };

describe("resolveRole", () => {
  // (staff, grader, checks back, student work, cached) → role, resolved
  const table: [Partial<RoleInputs>, string, boolean][] = [
    [{ signedIn: false, staff: true }, "unknown", false],
    [{}, "unknown", false],
    [{ cached: "teacher" }, "teacher", false],
    [{ cached: "student" }, "student", false],
    [{ staff: true }, "teacher", true],
    [{ staff: true, cached: "student" }, "teacher", true],
    [{ grader: true }, "teacher", true],
    [{ staff: true, studentWork: true }, "both", true],
    [{ staff: false, assignmentsChecked: true }, "unknown", false],
    [{ staff: false, assignmentsChecked: true, cached: "teacher" }, "teacher", false],
    [{ staff: false, assignmentsChecked: true, gradingChecked: true }, "student", true],
    [{ staff: false, assignmentsChecked: true, gradingChecked: true, cached: "teacher" }, "student", true],
    [{ staff: false, assignmentsChecked: true, gradingChecked: true, grader: true }, "teacher", true],
    // Task Mentor couldn't say (MIS down): once both checks are back, the student layout.
    [{ staff: null, assignmentsChecked: true, gradingChecked: true }, "student", true],
  ];
  it.each(table)("%o → %s", (over, role, resolved) => {
    expect(resolveRole({ ...base, ...over })).toEqual({ role, resolved });
  });

  it("uses the cached role at startup and lets the network correct it", () => {
    const startup = resolveRole({ ...base, cached: "teacher" });
    expect(startup).toEqual({ role: "teacher", resolved: false });
    const answered = resolveRole({ ...base, cached: "teacher", staff: false, assignmentsChecked: true, gradingChecked: true });
    expect(answered).toEqual({ role: "student", resolved: true });
  });
});

describe("whenRoleResolved", () => {
  it("answers when the role is settled, or after the timeout with what is known", async () => {
    useRole.setState({ role: "unknown", resolved: false });
    const waiting = whenRoleResolved(1000);
    useRole.setState({ role: "teacher", resolved: true });
    await expect(waiting).resolves.toEqual({ role: "teacher", resolved: true });
    useRole.setState({ role: "unknown", resolved: false });
    await expect(whenRoleResolved(10)).resolves.toEqual({ role: "unknown", resolved: false });
  });
});
