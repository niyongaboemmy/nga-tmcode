import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graphLayout";

const c = (hash: string, parents: string[]) => ({ hash, short: hash, parents, author: "A", date: 0, refs: "", subject: hash });

describe("commit graph lanes", () => {
  it("a straight history stays in one lane", () => {
    const rows = layoutGraph([c("c", ["b"]), c("b", ["a"]), c("a", [])]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows[2].after).toEqual([]);
  });

  it("a merge opens a second lane for the branch, which joins again at the fork", () => {
    // m merges f into main; f and b both come from a.
    const rows = layoutGraph([c("m", ["b", "f"]), c("f", ["a"]), c("b", ["a"]), c("a", [])]);
    expect(rows.map((r) => [r.commit.hash, r.col])).toEqual([
      ["m", 0],
      ["f", 1],
      ["b", 0],
      ["a", 0],
    ]);
    expect(rows[0].parentCols).toEqual([0, 1]);
    // At a, the branch's lane (waiting for a too) ends.
    expect(rows[3].before).toEqual(["a", "a"]);
    expect(rows[3].after).toEqual([]);
  });

  it("an unrelated branch tip gets its own lane", () => {
    const rows = layoutGraph([c("x", ["y"]), c("main", ["y"]), c("y", [])]);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0]);
  });
});

describe("merge editor choices", () => {
  it("resolves the chosen conflicts and keeps the others", async () => {
    const { applyChoices } = await import("./conflicts");
    const text = "a\n<<<<<<< HEAD\nmine1\n=======\ntheirs1\n>>>>>>> b\nmid\n<<<<<<< HEAD\nmine2\n=======\ntheirs2\n>>>>>>> b\nz";
    expect(applyChoices(text, { 0: "incoming" })).toBe("a\ntheirs1\nmid\n<<<<<<< HEAD\nmine2\n=======\ntheirs2\n>>>>>>> b\nz");
    expect(applyChoices(text, { 0: "current", 1: "both" })).toBe("a\nmine1\nmid\nmine2\ntheirs2\nz");
  });
});
