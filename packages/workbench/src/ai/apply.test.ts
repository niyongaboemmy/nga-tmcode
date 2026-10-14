import { describe, expect, it } from "vitest";
import { isWholeFile } from "./apply";

describe("isWholeFile (where an applied code block goes)", () => {
  it("a rewrite of the file replaces it", () => {
    expect(isWholeFile("console.log('hi');\nconst x = 1;\n", "console.info('hi');\nconst x = 1;")).toBe(true);
    expect(isWholeFile("a\nb\nc\nd\ne\n", "a\nb\nC\nd\ne\nf")).toBe(true);
  });
  it("a fragment is not the whole file", () => {
    const file = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    expect(isWholeFile(file, "function add(a, b) {\n  return a + b;\n}")).toBe(false);
  });
});
