import { describe, expect, it } from "vitest";
import { parseDiagnostics, toWorkspacePath } from "./diagnostics";

describe("parseDiagnostics", () => {
  it("reads gcc/clang errors and warnings", () => {
    const d = parseDiagnostics(
      "/w/task/main.c:5:12: error: expected ';' before 'return'\n/w/task/main.c:3:9: warning: unused variable 'x' [-Wunused-variable]\n1 error generated.",
    );
    expect(d).toEqual([
      { file: "/w/task/main.c", line: 5, column: 12, severity: "error", message: "expected ';' before 'return'", source: "compiler" },
      { file: "/w/task/main.c", line: 3, column: 9, severity: "warning", message: "unused variable 'x' [-Wunused-variable]", source: "compiler" },
    ]);
  });

  it("reads javac errors", () => {
    const d = parseDiagnostics("Main.java:7: error: cannot find symbol\n        Sytem.out.println(x);\n        ^");
    expect(d[0]).toMatchObject({ file: "Main.java", line: 7, severity: "error", message: "cannot find symbol" });
  });

  it("reads the failing frame of a Python traceback", () => {
    const d = parseDiagnostics(
      'Traceback (most recent call last):\n  File "/w/main.py", line 9, in <module>\n    main()\n  File "/w/main.py", line 4, in main\n    print(1/0)\nZeroDivisionError: division by zero\n',
    );
    expect(d).toEqual([{ file: "/w/main.py", line: 4, column: 1, severity: "error", message: "ZeroDivisionError: division by zero", source: "python" }]);
  });

  it("reads Node errors", () => {
    const d = parseDiagnostics("/w/js/sum.js:2\nconsole.lg(a);\n        ^\n\nTypeError: console.lg is not a function\n    at Object.<anonymous>");
    expect(d[0]).toMatchObject({ file: "/w/js/sum.js", line: 2, message: "TypeError: console.lg is not a function" });
  });

  it("ignores ordinary output", () => {
    expect(parseDiagnostics("Hello, NGA!\n42\n")).toEqual([]);
  });
});

describe("toWorkspacePath", () => {
  it("maps absolute and relative paths into the workspace", () => {
    expect(toWorkspacePath("/Users/s/exam/task1/main.c", "/Users/s/exam", "task1")).toBe("task1/main.c");
    expect(toWorkspacePath("Main.java", "/Users/s/exam", "task2")).toBe("task2/Main.java");
    expect(toWorkspacePath("../lib/u.c", "/Users/s/exam", "task1/src")).toBe("task1/lib/u.c");
    expect(toWorkspacePath("/usr/include/stdio.h", "/Users/s/exam", "")).toBeNull();
    expect(toWorkspacePath("C:\\exam\\t\\m.c", "C:\\exam", "t")).toBe("t/m.c");
  });
});
