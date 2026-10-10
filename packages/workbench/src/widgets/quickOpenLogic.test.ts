import { describe, expect, it } from "vitest";
import { matchPath, modeOfValue, rankFiles } from "./quickOpenLogic";
import { nextUntitledPath, isUntitled } from "../util/untitled";
import { basename } from "../util/paths";
import { validateSavePath } from "../commands/untitled";

describe("modeOfValue", () => {
  it("switches on VS Code's prefixes", () => {
    const o = { workspaceSymbols: false };
    expect(modeOfValue(">toggle", o)).toEqual({ mode: "commands", query: "toggle" });
    expect(modeOfValue(":12", o)).toEqual({ mode: "line", query: "12" });
    expect(modeOfValue("@main", o)).toEqual({ mode: "symbols", query: "main" });
    expect(modeOfValue("?", o)).toEqual({ mode: "help", query: "" });
    expect(modeOfValue("main.py:3", o)).toEqual({ mode: "files", query: "main.py:3" });
  });
  it("hides # without a workspace symbol provider", () => {
    expect(modeOfValue("#foo", { workspaceSymbols: false }).mode).toBe("files");
    expect(modeOfValue("#foo", { workspaceSymbols: true })).toEqual({ mode: "workspaceSymbols", query: "foo" });
  });
});

describe("matchPath", () => {
  it("prefers a hit in the file name", () => {
    const name = matchPath("util", "src/utils.ts")!;
    const path = matchPath("srcut", "src/utils.ts")!;
    expect(name.labelIndices).toEqual([0, 1, 2, 3]);
    expect(path).not.toBeNull();
    expect(name.score).toBeGreaterThan(path.score);
    // Folder hits highlight the folder part.
    expect(path.descIndices).toEqual([0, 1, 2]);
    expect(path.labelIndices).toEqual([0, 1]);
  });
  it("matches across folders", () => {
    expect(matchPath("react/app", "react-app/src/App.jsx")).not.toBeNull();
    expect(matchPath("zzz", "src/utils.ts")).toBeNull();
  });
});

describe("rankFiles", () => {
  const files = ["main.py", "src/utils.ts", "web/app.js", "js/sum.js"];
  it("lists recently opened files first when the query is empty", () => {
    expect(rankFiles("", files, ["web/app.js", "gone.txt"]).map((r) => [r.path, r.recent])).toEqual([
      ["web/app.js", true],
      ["main.py", false],
      ["src/utils.ts", false],
      ["js/sum.js", false],
    ]);
  });
  it("ranks by score, recent files winning ties", () => {
    const r = rankFiles("js", files, ["js/sum.js"]);
    expect(r[0].path).toBe("js/sum.js");
  });
});

describe("untitled", () => {
  it("names untitled buffers like VS Code", () => {
    expect(nextUntitledPath([])).toBe("tmcode-untitled:Untitled-1");
    expect(nextUntitledPath(["tmcode-untitled:Untitled-1", "a.ts"])).toBe("tmcode-untitled:Untitled-2");
    expect(isUntitled("tmcode-untitled:Untitled-2")).toBe(true);
    expect(isUntitled("Untitled-2")).toBe(false);
    expect(basename("tmcode-untitled:Untitled-2")).toBe("Untitled-2");
  });
  it("only saves inside the folder", () => {
    expect(validateSavePath("notes.txt")).toBeNull();
    expect(validateSavePath("src/notes.txt")).toBeNull();
    expect(validateSavePath("")).toBeTruthy();
    expect(validateSavePath("../x.txt")).toBeTruthy();
    expect(validateSavePath("/etc/passwd")).toBeTruthy();
    expect(validateSavePath("C:/x.txt")).toBeTruthy();
    expect(validateSavePath("a/")).toBeTruthy();
  });
});
