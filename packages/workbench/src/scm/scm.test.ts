import { describe, expect, it } from "vitest";
import type { GitStatus } from "../platform/types";
import { classifyGitError } from "./errors";
import { diffLines, gutterMarks, splitLines } from "./lineDiff";
import { branchLabel, changeCount, decorationsOf, discardPlan, groupsOf, isIgnored, primaryAction, validateBranchName } from "./model";
import { ProgressTracker, parseProgress } from "./progress";
import { normalizeCloneUrl, repoNameFromUrl } from "./url";

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main",
  oid: "abc",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  entries: [],
  truncated: false,
  root: "/r",
  prefix: "",
  remotes: ["origin"],
  merging: false,
  ...over,
});

describe("status model", () => {
  const s = status({
    entries: [
      { path: "src/app.ts", x: ".", y: "M", kind: "changed" },
      { path: "both.py", x: "M", y: "M", kind: "changed" },
      { path: "new.txt", x: "A", y: ".", kind: "changed" },
      { path: "gone.md", x: ".", y: "D", kind: "changed" },
      { path: "docs/renamed.md", orig_path: "old.md", x: "R", y: ".", kind: "renamed" },
      { path: "c.c", x: "U", y: "U", kind: "unmerged" },
      { path: "notes/todo.txt", x: "?", y: "?", kind: "untracked" },
      { path: "build/out.o", x: "!", y: "!", kind: "ignored" },
    ],
  });

  it("splits entries into Merge / Staged / Changes with VS Code letters", () => {
    const g = groupsOf(s);
    expect(g.merge.map((r) => [r.path, r.letter, r.tooltip])).toEqual([["c.c", "!", "Conflict: Both Modified"]]);
    expect(g.staged.map((r) => [r.path, r.letter])).toEqual([
      ["both.py", "M"],
      ["docs/renamed.md", "R"],
      ["new.txt", "A"],
    ]);
    expect(g.staged.find((r) => r.letter === "R")?.origPath).toBe("old.md");
    expect(g.changes.map((r) => [r.path, r.letter, r.color])).toEqual([
      ["both.py", "M", "modified"],
      ["gone.md", "D", "deleted"],
      ["notes/todo.txt", "U", "untracked"],
      ["src/app.ts", "M", "modified"],
    ]);
    expect(g.changes.find((r) => r.path === "gone.md")?.deleted).toBe(true);
    expect(g.changes.find((r) => r.path === "notes/todo.txt")?.untracked).toBe(true);
    expect(changeCount(s)).toBe(8);
    expect(groupsOf(null)).toEqual({ merge: [], staged: [], changes: [] });
  });

  it("decorates files and the folders above them", () => {
    const d = decorationsOf(s);
    expect(d["src/app.ts"]).toMatchObject({ letter: "M", color: "modified" });
    expect(d["src"]).toMatchObject({ letter: "", color: "modified" });
    expect(d["notes/todo.txt"]).toMatchObject({ letter: "U", color: "untracked" });
    expect(d["notes"].color).toBe("untracked");
    expect(d["new.txt"]).toMatchObject({ letter: "A", color: "added" });
    expect(d["c.c"]).toMatchObject({ letter: "!", color: "conflict" });
    expect(d["build/out.o"]).toBeUndefined();
    // A conflict beats a modification for the folder colour.
    const d2 = decorationsOf(status({ entries: [{ path: "a/x", x: ".", y: "M", kind: "changed" }, { path: "a/y", x: "U", y: "U", kind: "unmerged" }] }));
    expect(d2["a"].color).toBe("conflict");
  });

  it("knows ignored folders hide everything inside", () => {
    expect(isIgnored("node_modules/react/index.js", { node_modules: true })).toBe(true);
    expect(isIgnored("src/a.ts", { node_modules: true })).toBe(false);
  });

  it("labels the branch like the VS Code status bar", () => {
    expect(branchLabel(s)).toBe("main*+!");
    expect(branchLabel(status())).toBe("main");
    expect(branchLabel(status({ branch: null, oid: "8f3a2b1c9d" }))).toBe("8f3a2b1c");
    expect(branchLabel(status({ entries: [{ path: "a", x: "A", y: ".", kind: "changed" }] }))).toBe("main+");
  });

  it("picks the primary button: commit, sync or publish", () => {
    expect(primaryAction(s)).toBe("commit");
    expect(primaryAction(status({ ahead: 2 }))).toBe("sync");
    expect(primaryAction(status({ upstream: null }))).toBe("publish");
    expect(primaryAction(status({ upstream: null, remotes: [] }))).toBe("commit");
    expect(primaryAction(status())).toBe("commit");
  });

  it("validates branch names like git", () => {
    expect(validateBranchName("feature/login")).toBeNull();
    for (const bad of ["", " ", "-x", "a..b", "a b", "x.lock", "a~", "a:b", "@", "a/", "x@{1}"]) expect(validateBranchName(bad)).not.toBeNull();
  });

  it("plans discards: restore tracked, delete untracked", () => {
    const g = groupsOf(s);
    expect(discardPlan(g.changes)).toEqual({ tracked: ["both.py", "gone.md", "src/app.ts"], untracked: ["notes/todo.txt"] });
  });
});

describe("line diff", () => {
  it("finds added, modified and deleted lines", () => {
    const a = ["a", "b", "c", "d", "e"];
    expect(gutterMarks(a, a)).toEqual([]);
    expect(gutterMarks(a, ["a", "b", "X", "c", "d", "e"])).toEqual([{ kind: "added", startLine: 3, endLine: 3 }]);
    expect(gutterMarks(a, ["a", "B", "c", "d", "e"])).toEqual([{ kind: "modified", startLine: 2, endLine: 2 }]);
    expect(gutterMarks(a, ["a", "b", "e"])).toEqual([{ kind: "deleted", startLine: 2, endLine: 2 }]);
    expect(gutterMarks(a, ["b", "c", "d", "e"])).toEqual([{ kind: "deleted", startLine: 0, endLine: 0 }]);
    expect(gutterMarks(a, ["a", "B", "c", "d", "e", "f", "g"])).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
      { kind: "added", startLine: 6, endLine: 7 },
    ]);
  });

  it("handles separate changes in the middle (Myers)", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const b = ["1", "X", "3", "4", "5", "7", "8", "9"];
    expect(gutterMarks(a, b)).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
      { kind: "deleted", startLine: 5, endLine: 5 },
      { kind: "added", startLine: 8, endLine: 8 },
    ]);
  });

  it("produces hunks that rebuild the target", () => {
    const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const r = rnd(42);
    for (let t = 0; t < 50; t++) {
      const a = Array.from({ length: 30 }, () => String(Math.floor(r() * 6)));
      const b = a.flatMap((l) => (r() < 0.15 ? [] : r() < 0.15 ? [l, "new"] : r() < 0.1 ? ["chg"] : [l]));
      const out: string[] = [];
      let i = 0;
      for (const h of diffLines(a, b)) {
        out.push(...a.slice(i, h.origStart), ...b.slice(h.modStart, h.modStart + h.modLength));
        i = h.origStart + h.origLength;
      }
      out.push(...a.slice(i));
      expect(out).toEqual(b);
    }
  });

  it("ignores line-ending style", () => {
    expect(gutterMarks(splitLines("a\r\nb\r\n"), splitLines("a\nb\n"))).toEqual([]);
  });

  it("stays fast on big files", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i % 7 === 0 ? `${l}!` : l));
    const t = performance.now();
    const marks = gutterMarks(a, b);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(marks.length).toBeGreaterThan(0);
  });
});

describe("progress", () => {
  it("parses git's progress lines", () => {
    expect(parseProgress("Receiving objects:  45% (450/1000), 1.2 MiB | 1.0 MiB/s")).toEqual({ phase: "Receiving objects", percent: 45, overall: 52 });
    expect(parseProgress("remote: Counting objects: 100% (10/10), done.")?.overall).toBe(10);
    expect(parseProgress("Writing objects: 100% (3/3), 280 bytes | 280.00 KiB/s, done.")?.overall).toBe(90);
    expect(parseProgress("To https://github.com/a/b.git")).toBeNull();
  });

  it("only moves forward", () => {
    const t = new ProgressTracker();
    t.update("Receiving objects: 50% (5/10)");
    t.update("Counting objects: 100% (10/10)");
    expect(t.overall).toBe(55);
    t.update("Resolving deltas: 100% (4/4), done.");
    expect(t.overall).toBe(98);
  });
});

describe("git errors", () => {
  const kind = (s: string) => classifyGitError(new Error(s)).kind;
  it("maps common failures to actions", () => {
    expect(kind("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth");
    expect(classifyGitError("remote: Invalid username or password.\nfatal: Authentication failed").actions[0].id).toBe("signIn");
    expect(kind(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs")).toBe("rejected");
    expect(kind("hint: Updates were rejected because the tip of your current branch is behind")).toBe("rejected");
    expect(kind("CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.")).toBe("conflict");
    expect(kind("fatal: The current branch feature has no upstream branch.")).toBe("noUpstream");
    expect(kind("*** Please tell me who you are.")).toBe("identity");
    expect(kind("error: Your local changes to the following files would be overwritten by checkout:")).toBe("dirtyCheckout");
    expect(kind("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe("network");
    expect(kind("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found")).toBe("notFound");
    expect(kind("Cancelled")).toBe("cancelled");
    expect(classifyGitError("fatal: something odd happened").message).toBe("Git: something odd happened");
  });
});

describe("clone URLs", () => {
  it("accepts real remotes and refuses tricks", () => {
    expect(normalizeCloneUrl("https://github.com/octocat/Hello-World.git")).toBe("https://github.com/octocat/Hello-World.git");
    expect(normalizeCloneUrl("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
    expect(normalizeCloneUrl("github.com/octocat/Hello-World")).toBe("https://github.com/octocat/Hello-World");
    for (const bad of ["", "--upload-pack=x", "ext::sh -c x", "file:///etc", "/tmp/x", "C:\\x", "https://github.com", "https://a b/c"]) expect(normalizeCloneUrl(bad)).toBeNull();
    expect(repoNameFromUrl("https://github.com/octocat/Hello-World.git")).toBe("Hello-World");
    expect(repoNameFromUrl("git@github.com:o/r.git")).toBe("r");
  });
});
