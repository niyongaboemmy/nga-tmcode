import { describe, expect, it } from "vitest";
import { NavigationStack, mruOrder, parseLineSuffix, touchMru } from "./history";

describe("MRU", () => {
  it("moves the used editor to the front", () => {
    expect(touchMru(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touchMru(["a"], "a")).toEqual(["a"]);
    expect(touchMru(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
  it("orders open editors by use, never-used ones last in tab order", () => {
    expect(mruOrder(["c", "x", "a"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
  });
});

describe("NavigationStack", () => {
  it("records jumps, merges nearby moves, and goes back and forward", () => {
    const n = new NavigationStack();
    n.record({ path: "a.ts", line: 1, column: 1 });
    n.record({ path: "a.ts", line: 4, column: 1 }); // nearby: replaces
    n.record({ path: "a.ts", line: 40, column: 2 }); // jump
    n.record({ path: "b.ts", line: 3, column: 1 }); // another file (after F12)
    expect(n.entries.map((e) => `${e.path}:${e.line}`)).toEqual(["a.ts:4", "a.ts:40", "b.ts:3"]);
    expect(n.back()).toMatchObject({ path: "a.ts", line: 40 });
    expect(n.back()).toMatchObject({ path: "a.ts", line: 4 });
    expect(n.back()).toBeNull();
    expect(n.forward()).toMatchObject({ path: "a.ts", line: 40 });
    // A new jump drops what was forward.
    n.record({ path: "c.ts", line: 9, column: 1 });
    expect(n.canForward()).toBe(false);
    expect(n.entries.map((e) => e.path)).toEqual(["a.ts", "a.ts", "c.ts"]);
  });
  it("forgets a deleted file", () => {
    const n = new NavigationStack();
    n.record({ path: "a.ts", line: 1, column: 1 });
    n.record({ path: "b.ts", line: 1, column: 1 });
    n.record({ path: "c.ts", line: 1, column: 1 });
    n.clear("b.ts");
    expect(n.entries.map((e) => e.path)).toEqual(["a.ts", "c.ts"]);
    expect(n.index).toBe(1);
  });
});

describe("parseLineSuffix", () => {
  it("reads :line, :line:col and (line,col)", () => {
    expect(parseLineSuffix("main.py:12")).toEqual({ query: "main.py", line: 12, column: undefined });
    expect(parseLineSuffix("src/app.ts:3:7")).toEqual({ query: "src/app.ts", line: 3, column: 7 });
    expect(parseLineSuffix("app.ts(5, 2)")).toEqual({ query: "app.ts", line: 5, column: 2 });
    expect(parseLineSuffix("main.py:")).toEqual({ query: "main.py" });
    expect(parseLineSuffix("main.py")).toEqual({ query: "main.py" });
    expect(parseLineSuffix("main.py:0")).toEqual({ query: "main.py", line: 1, column: undefined });
  });
});
