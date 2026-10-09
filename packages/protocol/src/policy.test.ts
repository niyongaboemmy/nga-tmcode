import { describe, expect, it } from "vitest";
import { EXAM_POLICY_DEFAULTS, PRACTICE_POLICY, terminalAllowed } from "./policy";

describe("terminal policy", () => {
  it("opens a shell only when the terminal is full", () => {
    expect(terminalAllowed(PRACTICE_POLICY)).toBe(true);
    expect(terminalAllowed(EXAM_POLICY_DEFAULTS)).toBe(false);
    // No restricted console exists yet, so "restricted" must not give a full shell.
    expect(terminalAllowed({ terminal: "restricted" })).toBe(false);
  });
});
