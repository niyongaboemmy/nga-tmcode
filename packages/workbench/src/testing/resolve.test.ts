import { describe, expect, it } from "vitest";
import { detectSuites } from "./frameworks";
import { resolveTest, type TestInput } from "./resolve";

const folder = (files: Record<string, string>, opts: { dir?: string; dirs?: string[] } = {}) => ({ dir: opts.dir ?? "", files: Object.keys(files), dirs: opts.dirs ?? [], read: files });
const suites = detectSuites([
  folder({ "main.py": "", "test_main.py": "" }),
  folder({ "package.json": JSON.stringify({ devDependencies: { vitest: "2" }, scripts: { test: "vitest" } }) }, { dir: "web", dirs: ["src"] }),
]);
const base: TestInput = { samples: 0, samplesShipped: false, suites, activePath: null, exam: false, frameworks: true };

describe("one Test: resolveTest", () => {
  it("an exam's or teacher's example tests come first", () => {
    expect(resolveTest({ ...base, samples: 3, exam: true, activePath: "test_main.py" })).toMatchObject({ kind: "samples", reason: "they are this task's example tests" });
    expect(resolveTest({ ...base, samples: 2, samplesShipped: true })).toMatchObject({ kind: "samples" });
  });

  it("a test file tests itself; another file tests its project", () => {
    expect(resolveTest({ ...base, activePath: "test_main.py" })).toMatchObject({ kind: "file", file: "test_main.py", label: "Test test_main.py" });
    expect(resolveTest({ ...base, activePath: "web/src/App.tsx" })).toMatchObject({ kind: "suite", label: "Test Vitest", reason: "web uses Vitest" });
    expect(resolveTest({ ...base, activePath: "main.py" })).toMatchObject({ kind: "suite", label: "Test pytest" });
  });

  it("without frameworks: the student's examples, else Add a Test", () => {
    expect(resolveTest({ ...base, frameworks: false, samples: 1, activePath: "main.py" })).toMatchObject({ kind: "samples", reason: "they are this folder's example tests" });
    expect(resolveTest({ ...base, suites: [], activePath: "main.py" })).toMatchObject({ kind: "add", label: "Add a Test" });
  });
});

describe("test frameworks: fixes", () => {
  it("one suite for a project and its tests/ folder", () => {
    const s = detectSuites([folder({ "app.py": "", "requirements.txt": "flask" }, { dirs: ["tests"] }), folder({ "test_app.py": "" }, { dir: "tests" })]);
    expect(s.map((x) => x.id)).toEqual(["pytest:"]);
  });

  it("unittest when pytest isn't installed (and not asked for)", () => {
    const [s] = detectSuites([folder({ "calc.py": "", "test_calc.py": "" })]);
    expect(s.fallback?.probe).toMatch(/import pytest/);
    expect(s.fallback?.command()).toMatch(/-m unittest discover -v -s \. -p "\*test\*\.py"/);
    expect(s.fallback?.command({ file: "test_calc.py", test: { name: "test_add", group: "test_calc.TestCalc" } })).toMatch(/unittest -v test_calc\.py -k test_add/);
    const [asked] = detectSuites([folder({ "requirements.txt": "pytest", "test_calc.py": "" })]);
    expect(asked.fallback).toBeUndefined();
  });

  it("node:test files without package.json", () => {
    const [s] = detectSuites([folder({ "sum.js": "", "sum.test.js": "" })]);
    expect(s.framework).toBe("node");
  });
});
