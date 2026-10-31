import { describe, expect, it } from "vitest";
import { documentKind, findTask, guessDelimiter, parseCsv, previewKind, toggleTask } from "./documentPreview";

describe("previews", () => {
  it("knows documents and previewable text", () => {
    expect(documentKind("a/Report.PDF")).toBe("pdf");
    expect(documentKind("cv.docx")).toBe("docx");
    expect(documentKind("notes.doc")).toBeNull();
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("data.tsv")).toBe("csv");
    expect(previewKind("main.py")).toBeNull();
  });

  it("ticks the n-th task box, skipping code blocks", () => {
    const src = ["# Plan", "- [ ] one", "```", "- [ ] not a task", "```", "1. [x] two", "> - [ ] quoted"].join("\n");
    expect(findTask(src, 1)).toEqual({ line: 5, column: 4, checked: true });
    expect(toggleTask(src, 0).split("\n")[1]).toBe("- [x] one");
    expect(toggleTask(src, 1).split("\n")[5]).toBe("1. [ ] two");
    expect(toggleTask(src, 2).split("\n")[6]).toBe("> - [x] quoted");
    expect(toggleTask(src, 3)).toBe(src);
  });

  it("parses CSV with quotes, commas and newlines inside fields", () => {
    expect(parseCsv('name,note\r\n"Ada, L.","said ""hi""\nthen left"\nBob,')).toEqual([
      ["name", "note"],
      ["Ada, L.", 'said "hi"\nthen left'],
      ["Bob", ""],
    ]);
    expect(parseCsv("a,b\n1,2\n3,4\n", ",", 2)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(guessDelimiter("x.csv", "a;b;c\n1;2;3")).toBe(";");
    expect(guessDelimiter("x.tsv", "a,b")).toBe("\t");
  });
});
