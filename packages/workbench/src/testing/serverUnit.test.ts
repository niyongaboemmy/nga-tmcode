import { describe, expect, it } from "vitest";
import type { TestResult } from "@nga/runtimes/testing";
import { failuresFirst, reportProblem } from "./serverUnit";

const r = (id: string, status: TestResult["status"], file: string | null = null, line: number | null = null) => ({ id, name: id, group: "", file, line, status, durationMs: 1, message: null, details: null }) as TestResult;

describe("server unit-test results", () => {
  it("puts failures first, then errors, passed, skipped; by file and line", () => {
    const sorted = failuresFirst([r("p", "passed", "a.py", 1), r("s", "skipped"), r("f2", "failed", "b.py", 3), r("e", "error"), r("f1", "failed", "b.py", 1)]);
    expect(sorted.map((x) => x.id)).toEqual(["f1", "f2", "e", "p", "s"]);
  });

  it("says why there are no results", () => {
    const base = { framework: "pytest", total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, time_ms: 0, output: "", truncated: false, tests: [] as TestResult[] };
    expect(reportProblem({ ...base, verdict: "error" })).toBe("Did not compile");
    expect(reportProblem({ ...base, verdict: "time-limit" })).toBe("Too slow (time limit)");
    expect(reportProblem({ ...base, verdict: "passed" })).toBe("No tests were found.");
    expect(reportProblem({ ...base, verdict: "failed", tests: [r("x", "failed")] })).toBeNull();
    expect(reportProblem(null)).toBeNull();
  });
});
