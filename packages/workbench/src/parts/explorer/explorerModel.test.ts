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
