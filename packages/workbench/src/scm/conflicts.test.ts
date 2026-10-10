import { describe, expect, it } from "vitest";
import { hasConflictMarkers, parseConflicts, resolveAll, resolveConflict } from "./conflicts";
import { describeHunk, hunkAtLine, hunksBetween, revertHunk, stageHunk } from "./hunks";

const FILE = [
  "def letter(average):",
  "<<<<<<< HEAD",
  '    if average >= 90: return "A+"',
  "=======",
  '    if average >= 85: return "A"',
  ">>>>>>> feature/grades",
  "    return grade",
  "<<<<<<< ours",
  "x = 1",
  "||||||| base",
  "x = 0",
  "=======",
  "x = 2",
  "y = 3",
  ">>>>>>> theirs",
  "",
].join("\n");

describe("merge conflict markers", () => {
  it("parses blocks with labels, and diff3 base sections", () => {
    const [a, b] = parseConflicts(FILE);
    expect(a).toMatchObject({ start: 2, base: null, middle: 4, end: 6, currentLabel: "HEAD", incomingLabel: "feature/grades" });
    expect(a.current).toEqual(['    if average >= 90: return "A+"']);
    expect(a.incoming).toEqual(['    if average >= 85: return "A"']);
    expect(b).toMatchObject({ start: 8, base: 10, middle: 12, end: 15, current: ["x = 1"], incoming: ["x = 2", "y = 3"] });
    expect(hasConflictMarkers(FILE)).toBe(true);
  });

  it("ignores half-written blocks and lookalike lines", () => {
    expect(parseConflicts("<<<<<<< HEAD\na\n=======\nb\n")).toEqual([]);
    expect(parseConflicts("========\n<<<<<<<< x\n")).toEqual([]);
    // A second start before the first closes: the first is broken, the second still counts.
    expect(parseConflicts("<<<<<<< a\nx\n<<<<<<< b\n1\n=======\n2\n>>>>>>> c\n").map((c) => c.start)).toEqual([3]);
    expect(hasConflictMarkers("a\n=======\nb")).toBe(false);
  });

  it("accepts current, incoming or both", () => {
    const [a] = parseConflicts(FILE);
    const cur = resolveConflict(FILE, a, "current").split("\n");
    expect(cur.slice(0, 3)).toEqual(["def letter(average):", '    if average >= 90: return "A+"', "    return grade"]);
    const inc = resolveConflict(FILE, a, "incoming").split("\n");
    expect(inc[1]).toBe('    if average >= 85: return "A"');
    const both = resolveConflict(FILE, a, "both").split("\n");
    expect(both.slice(1, 3)).toEqual(['    if average >= 90: return "A+"', '    if average >= 85: return "A"']);
    // The other block is untouched and still parses.
    expect(parseConflicts(both.join("\n"))).toHaveLength(1);
  });

  it("resolves everything at once and keeps CRLF files CRLF", () => {
    expect(hasConflictMarkers(resolveAll(FILE, "incoming"))).toBe(false);
    expect(resolveAll(FILE, "incoming")).toContain("x = 2\ny = 3\n");
    const crlf = "a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> x\r\nd";
    expect(resolveAll(crlf, "current")).toBe("a\r\nb\r\nd");
  });
});

describe("hunks: stage and revert one change", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";
  const current = "one\nTWO\nthree\nfour\nfive\nsix\n";

  it("finds the change under a line", () => {
    const hunks = hunksBetween(base, current);
    expect(hunks).toHaveLength(2);
    expect(hunkAtLine(hunks, 2)).toBe(hunks[0]);
    expect(hunkAtLine(hunks, 6)).toBe(hunks[1]);
    expect(hunkAtLine(hunks, 4)).toBeNull();
    expect(describeHunk(hunks[0])).toBe("line 2");
  });

  it("stages only that change into the index text", () => {
    const hunks = hunksBetween(base, current);
    expect(stageHunk(base, current, hunks[0])).toBe("one\nTWO\nthree\nfour\nfive\n");
    expect(stageHunk(base, current, hunks[1])).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
  });

  it("reverts only that change in the editor text", () => {
    const hunks = hunksBetween(base, current);
    expect(revertHunk(base, current, hunks[0])).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
    expect(revertHunk(base, current, hunks[1])).toBe("one\nTWO\nthree\nfour\nfive\n");
  });

  it("handles deletions (no lines of their own) and CRLF", () => {
    const b = "a\r\nb\r\nc\r\n";
    const c = "a\r\nc\r\n";
    const hunks = hunksBetween(b, c);
    expect(hunks).toEqual([{ origStart: 1, origLength: 1, modStart: 1, modLength: 0 }]);
    expect(hunkAtLine(hunks, 1)).toBe(hunks[0]);
    expect(describeHunk(hunks[0])).toBe("1 deleted line");
    expect(stageHunk(b, c, hunks[0])).toBe("a\r\nc\r\n");
    expect(revertHunk(b, c, hunks[0])).toBe(b);
  });
});
