import { describe, expect, it } from "vitest";
import { compileGlob, globMatcher, ignoredBy, parseGitignore, splitGlobList } from "./glob";

describe("glob patterns (files.exclude, search include/exclude)", () => {
  it("matches names at any depth and folders with their contents", () => {
    const m = globMatcher("*.py, node_modules");
    expect(m("main.py")).toBe(true);
    expect(m("src/app/main.py")).toBe(true);
    expect(m("main.pyc")).toBe(false);
    expect(m("node_modules")).toBe(true);
    expect(m("web/node_modules/react/index.js")).toBe(true);
    expect(m("src/node_modules_backup.txt")).toBe(false);
  });

  it("anchors patterns with a slash to the root", () => {
    const m = globMatcher("src/**/*.ts, /build");
    expect(m("src/a.ts")).toBe(true);
    expect(m("src/x/y/a.ts")).toBe(true);
    expect(m("lib/src/a.ts")).toBe(false);
    expect(m("build/out.js")).toBe(true);
    expect(m("web/build/out.js")).toBe(false);
  });

  it("understands **, ?, braces and character classes", () => {
    expect(compileGlob("**/.git")!.test(".git")).toBe(true);
    expect(compileGlob("**/.git")!.test("sub/.git/HEAD")).toBe(true);
    expect(globMatcher("*.{js,jsx}")("web/app.jsx")).toBe(true);
    expect(globMatcher("*.{js,jsx}")("web/app.ts")).toBe(false);
    expect(globMatcher("file?.txt")("file1.txt")).toBe(true);
    expect(globMatcher("file?.txt")("file10.txt")).toBe(false);
    expect(globMatcher("[ab]*.md")("b.md")).toBe(true);
    expect(globMatcher("[!ab]*.md")("b.md")).toBe(false);
    expect(splitGlobList("a, *.{x,y} ,, b")).toEqual(["a", "*.{x,y}", "b"]);
    expect(globMatcher("")("anything")).toBe(false);
  });
});

describe(".gitignore", () => {
  it("ignores, re-includes with !, and anchors to its folder", () => {
    const rules = [...parseGitignore("# build output\n*.log\nout/\n!keep.log\n/secret.txt\n"), ...parseGitignore("tmp\n", "web")];
    expect(ignoredBy(rules, "debug.log", false)).toBe(true);
    expect(ignoredBy(rules, "keep.log", false)).toBe(false);
    expect(ignoredBy(rules, "a/out", true)).toBe(true);
    expect(ignoredBy(rules, "a/out", false)).toBe(false); // "out/" is folders only
    expect(ignoredBy(rules, "secret.txt", false)).toBe(true);
    expect(ignoredBy(rules, "src/secret.txt", false)).toBe(false);
    expect(ignoredBy(rules, "web/tmp", true)).toBe(true);
    expect(ignoredBy(rules, "tmp", true)).toBe(false);
  });
});
