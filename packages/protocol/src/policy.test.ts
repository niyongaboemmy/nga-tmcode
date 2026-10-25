import { describe, expect, it } from "vitest";
import { EXAM_POLICY_DEFAULTS, PRACTICE_POLICY, PolicySchema, examAiAllowed, normalizeAiMode, terminalAllowed } from "./policy";

describe("terminal policy", () => {
  it("opens a shell only when the terminal is full", () => {
    expect(terminalAllowed(PRACTICE_POLICY)).toBe(true);
    expect(terminalAllowed(EXAM_POLICY_DEFAULTS)).toBe(false);
    // No restricted console exists yet, so "restricted" must not give a full shell.
    expect(terminalAllowed({ terminal: "restricted" })).toBe(false);
  });
});

describe("AI policy", () => {
  const { ai: _ai, ...withoutAi } = EXAM_POLICY_DEFAULTS;

  it("is off by default, in exams and in practice", () => {
    expect(EXAM_POLICY_DEFAULTS.ai).toBe("off");
    // Practice doesn't force AI on: Task Mentor's AI status decides outside exams.
    expect(PRACTICE_POLICY.ai).toBe("off");
  });

  it("reads an older Task Mentor's policy (no ai field) as off", () => {
    expect(PolicySchema.parse(withoutAi).ai).toBe("off");
  });

  it("keeps the teacher's choice and normalises anything else to off", () => {
    expect(PolicySchema.parse({ ...withoutAi, ai: "full" }).ai).toBe("full");
    expect(PolicySchema.parse({ ...withoutAi, ai: "hints" }).ai).toBe("hints");
    expect(PolicySchema.parse({ ...withoutAi, ai: "everything" }).ai).toBe("off");
    expect(PolicySchema.parse({ ...withoutAi, ai: null }).ai).toBe("off");
    expect(normalizeAiMode(undefined)).toBe("off");
    expect(normalizeAiMode("FULL")).toBe("off");
  });

  it("allows TMCode AI in an exam only when the teacher chose full", () => {
    expect(examAiAllowed({ ai: "full" })).toBe(true);
    expect(examAiAllowed({ ai: "hints" })).toBe(false);
    expect(examAiAllowed({ ai: "off" })).toBe(false);
  });
});
