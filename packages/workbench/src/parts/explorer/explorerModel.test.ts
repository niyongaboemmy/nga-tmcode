import { describe, expect, it } from "vitest";
import type { DirEntry } from "../../platform/types";
import { globMatcher } from "../../util/glob";
import { rangeBetween, rowLabel, topLevelPaths, typeAheadMatch, visibleRows } from "./explorerModel";

const d = (path: string): DirEntry => ({ name: path.split("/").pop()!, path, kind: "dir" });
const f = (path: string): DirEntry => ({ name: path.split("/").pop()!, path, kind: "file" });

const dirs: Record<string, DirEntry[]> = {
  "": [d(".git"), d("src"), d("web"), f("README.md")],
  ".git": [f(".git/HEAD")],
  src: [d("src/main")],
  "src/main": [d("src/main/java")],
  "src/main/java": [d("src/main/java/com")],
  "src/main/java/com": [d("src/main/java/com/x")],
  "src/main/java/com/x": [f("src/main/java/com/x/App.java")],
  web: [f("web/index.html"), f("web/app.js")],
};

describe("explorer rows", () => {
  const exclude = globMatcher("**/.git");

  it("hides files.exclude and compacts single-folder chains", () => {
    const expanded = { src: true, "src/main": true, "src/main/java": true, "src/main/java/com": true, "src/main/java/com/x": true } as Record<string, true>;
    const rows = visibleRows(dirs, expanded, { exclude, compact: true });
    expect(rows.map((r) => [rowLabel(r), r.depth])).toEqual([
      ["src/main/java/com/x", 0],
      ["App.java", 1],
      ["web", 0],
      ["README.md", 0],
    ]);
    expect(rows[0].entry.path).toBe("src/main/java/com/x");
  });

  it("shows one row per folder when compact folders is off", () => {
    const rows = visibleRows(dirs, { src: true }, { exclude: globMatcher(""), compact: false });
    expect(rows.map(rowLabel)).toEqual([".git", "src", "main", "web", "README.md"]);
  });

  it("selects ranges, jumps by typed prefix and keeps top-level paths", () => {
    const rows = visibleRows(dirs, { web: true }, { exclude, compact: true });
    expect(rangeBetween(rows, "web/index.html", "README.md")).toEqual(["web/index.html", "web/app.js", "README.md"]);
    expect(rangeBetween(rows, "README.md", "web")).toEqual(["web", "web/index.html", "web/app.js", "README.md"]);
    expect(rowLabel(rows[typeAheadMatch(rows, -1, "a")])).toBe("app.js");
    expect(rowLabel(rows[typeAheadMatch(rows, 0, "re")])).toBe("README.md");
    expect(typeAheadMatch(rows, 0, "zz")).toBe(-1);
    expect(topLevelPaths(["web", "web/app.js", "README.md"])).toEqual(["web", "README.md"]);
  });
});

describe("file nesting and Find in the Explorer", () => {
  const f = (path: string, kind: "file" | "dir" = "file") => ({ name: path.split("/").pop()!, path, kind });
  const none = () => false;

  it("nests generated and lock files under their file, once each", async () => {
    const { nestFiles, DEFAULT_NESTING } = await import("./explorerModel");
    const files = ["app.ts", "app.js", "app.d.ts", "app.js.map", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.app.json", "README.md", "LICENSE", "style.scss", "style.css", "other.js"].map((n) => f(n));
    const nests = nestFiles(files, DEFAULT_NESTING);
    const names = (p: string) => nests.get(p)?.map((e) => e.name).sort();
    expect(names("app.ts")).toEqual(["app.d.ts", "app.js", "app.js.map"]);
    expect(names("package.json")).toEqual(["package-lock.json"]);
    expect(names("tsconfig.json")).toEqual(["tsconfig.app.json"]);
    expect(names("README.md")).toEqual(["LICENSE"]);
    expect(names("style.scss")).toEqual(["style.css"]);
    // app.js is nested itself, so it is not a parent; other.js has nothing to nest.
    expect(nests.has("app.js")).toBe(false);
    expect(nests.has("other.js")).toBe(false);
  });

  it("rows: nested files show under their parent only when it is open", async () => {
    const { visibleRows, DEFAULT_NESTING } = await import("./explorerModel");
    const dirs = { "": [f("package.json"), f("package-lock.json"), f("index.js")] };
    const closed = visibleRows(dirs, {}, { exclude: none, compact: true, nesting: DEFAULT_NESTING });
    expect(closed.map((r) => [r.entry.name, r.depth, r.nested?.length ?? 0])).toEqual([["package.json", 0, 1], ["index.js", 0, 0]]);
    const open = visibleRows(dirs, { "package.json": true }, { exclude: none, compact: true, nesting: DEFAULT_NESTING });
    expect(open.map((r) => [r.entry.name, r.depth])).toEqual([["package.json", 0], ["package-lock.json", 1], ["index.js", 0]]);
    expect(visibleRows(dirs, {}, { exclude: none, compact: true }).map((r) => r.entry.name)).toEqual(["package.json", "package-lock.json", "index.js"]);
  });

  it("finds names in every loaded folder, with the folders above them", async () => {
    const { findRows } = await import("./explorerModel");
    const dirs = { "": [f("src", "dir"), f("readme.md")], src: [f("src/lib", "dir"), f("src/main.py")], "src/lib": [f("src/lib/helper.py"), f("src/lib/other.txt")] };
    const rows = findRows(dirs, none, "HELP");
    expect(rows.map((r) => [r.entry.path, r.depth, r.match])).toEqual([
      ["src", 0, undefined],
      ["src/lib", 1, undefined],
      ["src/lib/helper.py", 2, [0, 4]],
    ]);
    expect(findRows(dirs, none, "  ")).toEqual([]);
    expect(findRows(dirs, (p) => p.startsWith("src/lib"), "help")).toEqual([]);
  });
});
