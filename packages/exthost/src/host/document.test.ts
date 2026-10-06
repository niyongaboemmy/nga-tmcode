import { describe, expect, it } from "vitest";
import { DocumentData } from "./document";
import { Position, Range } from "../api/types";
import { Uri } from "../api/uri";
import { matchGlob } from "./glob";

const doc = (text: string) => new DocumentData(Uri.file("/a.js"), text, "javascript", 1, async () => true);

describe("TextDocument", () => {
  it("maps offsets and positions, validates and reads ranges", () => {
    const d = doc("ab\ncd\n\nefg");
    expect(d.document.lineCount).toBe(4);
    expect(d.offsetAt(new Position(1, 1))).toBe(4);
    expect(d.positionAt(4)).toEqual(new Position(1, 1));
    expect(d.positionAt(999)).toEqual(new Position(3, 3));
    expect(d.validatePosition(new Position(9, 9))).toEqual(new Position(3, 3));
    expect(d.getText(new Range(0, 1, 1, 1))).toBe("b\nc");
    expect(d.lineAt(2).isEmptyOrWhitespace).toBe(true);
    expect(d.lineAt(1).rangeIncludingLineBreak).toEqual(new Range(1, 0, 2, 0));
    expect(() => d.lineAt(4)).toThrow();
  });

  it("applies incremental changes in order", () => {
    const d = doc("hello world\nsecond");
    d.applyChange({ range: [0, 6, 0, 11], rangeOffset: 6, rangeLength: 5, text: "there\nnew" });
    expect(d.getText()).toBe("hello there\nnew\nsecond");
    d.applyChange({ range: [1, 0, 2, 0], rangeOffset: 12, rangeLength: 4, text: "" });
    expect(d.getText()).toBe("hello there\nsecond");
    expect(d.offsetAt(new Position(1, 0))).toBe(12);
  });

  it("keeps CRLF documents CRLF", () => {
    const d = doc("a\r\nb");
    expect(d.getText()).toBe("a\r\nb");
    expect(d.offsetAt(new Position(1, 0))).toBe(3);
  });

  it("finds words like VS Code", () => {
    const d = doc("const fooBar = obj.baz-1;");
    expect(d.getWordRangeAtPosition(new Position(0, 8))).toEqual(new Range(0, 6, 0, 12));
    expect(d.getText(d.getWordRangeAtPosition(new Position(0, 20))!)).toBe("baz");
    expect(d.getWordRangeAtPosition(new Position(0, 13))).toBeUndefined();
    expect(d.getText(d.getWordRangeAtPosition(new Position(0, 20), /[\w-]+/)!)).toBe("baz-1");
  });
});

describe("globs", () => {
  it("matches VS Code glob patterns", () => {
    expect(matchGlob("**/*.js", "a.js")).toBe(true);
    expect(matchGlob("**/*.js", "src/deep/a.js")).toBe(true);
    expect(matchGlob("*.js", "src/a.js")).toBe(false);
    expect(matchGlob("**/node_modules", "x/node_modules")).toBe(true);
    expect(matchGlob("src/**/*.{ts,tsx}", "src/a/b.tsx")).toBe(true);
    expect(matchGlob("src/**/*.{ts,tsx}", "lib/a.ts")).toBe(false);
    expect(matchGlob("file[0-9].txt", "file7.txt")).toBe(true);
    expect(matchGlob("a?c", "abc")).toBe(true);
  });
});
