import { describe, expect, it } from "vitest";
import { missingFor, toolsForAction } from "./preflight";
import type { RunAction } from "./projectKind";

const act = (a: Partial<RunAction>): RunAction => ({ id: "x", kind: "task", label: "x", icon: "play", ...a }) as RunAction;

describe("preflight: what a run needs", () => {
  it("knows the tools of every run door", () => {
    expect(toolsForAction(act({ kind: "runFile", entry: "Main.java" })).map((t) => t.tool)).toEqual(["javac", "java"]);
    expect(toolsForAction(act({ kind: "runFile", entry: "main.c" })).map((t) => t.guide)).toEqual(["c"]);
    expect(toolsForAction(act({ command: 'php "calc.php"' }))).toEqual([{ tool: "php", guide: "php" }]);
    expect(toolsForAction(act({ command: 'kotlinc "a.kt" -include-runtime -d "x.jar" && java -jar "x.jar"' })).map((t) => t.tool)).toEqual(["kotlinc", "java"]);
    expect(toolsForAction(act({ kind: "devServer", command: "npm run dev", prelude: "npm install" } as Partial<RunAction>)).map((t) => t.tool)).toEqual(["node"]);
    // Tools TMCode doesn't detect (make, mvn) never block a run.
    expect(toolsForAction(act({ command: "make run" }))).toEqual([]);
    expect(toolsForAction(act({ kind: "livePreview", entry: "index.html" }))).toEqual([]);
  });

  it("names the first missing tool", () => {
    expect(missingFor(act({ command: 'ruby "a.rb"' }), ["python", "node"])).toEqual({ tool: "ruby", guide: "ruby" });
    expect(missingFor(act({ command: 'ruby "a.rb"' }), ["ruby"])).toBeNull();
    expect(missingFor(act({ kind: "runFile", entry: "main.py" }), ["python"])).toBeNull();
  });
});
