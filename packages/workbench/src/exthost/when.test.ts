import { describe, expect, it } from "vitest";
import { evaluateWhen } from "./when";

const ctx = (values: Record<string, unknown>) => (k: string) => values[k];

describe("when clauses", () => {
  const c = ctx({ editorTextFocus: true, resourceLangId: "javascript", resourceScheme: "file", editorHasSelection: false, "config.minifier.enableMitify": true, count: 3, list: ["a", "b"], obj: { x: 1 }, resourceFilename: "app.test.ts" });

  it("handles keys, negation, && and || with VS Code precedence", () => {
    expect(evaluateWhen(undefined, c)).toBe(true);
    expect(evaluateWhen("", c)).toBe(true);
    expect(evaluateWhen("editorTextFocus", c)).toBe(true);
    expect(evaluateWhen("!editorHasSelection", c)).toBe(true);
    expect(evaluateWhen("unknownKey", c)).toBe(false);
    expect(evaluateWhen("editorHasSelection || editorTextFocus && !unknownKey", c)).toBe(true);
    expect(evaluateWhen("(editorHasSelection || editorTextFocus) && unknownKey", c)).toBe(false);
  });

  it("compares with ==, !=, quotes, numbers and regexes", () => {
    expect(evaluateWhen("resourceLangId == javascript", c)).toBe(true);
    expect(evaluateWhen("resourceLangId == 'javascript'", c)).toBe(true);
    expect(evaluateWhen("resourceLangId != javascript", c)).toBe(false);
    expect(evaluateWhen("count > 2 && count <= 3", c)).toBe(true);
    expect(evaluateWhen("count == 3", c)).toBe(true);
    expect(evaluateWhen("resourceFilename =~ /\\.test\\.ts$/", c)).toBe(true);
    expect(evaluateWhen("resourceFilename =~ /^APP/i", c)).toBe(true);
    expect(evaluateWhen("resourceFilename =~ /\\.spec\\./", c)).toBe(false);
  });

  it("supports in / not in", () => {
    expect(evaluateWhen("resourceLangId in list", ctx({ resourceLangId: "a", list: ["a"] }))).toBe(true);
    expect(evaluateWhen("resourceLangId not in list", ctx({ resourceLangId: "z", list: ["a"] }))).toBe(true);
    expect(evaluateWhen("k in obj", ctx({ k: "x", obj: { x: 1 } }))).toBe(true);
  });

  it("evaluates a real menu clause (Code Formatter & Minifier)", () => {
    const clause =
      "editorTextFocus && (resourceScheme == 'file' || resourceScheme == 'untitled') && !editorHasSelection && (config.minifier.enableMitify && (resourceLangId == javascript || resourceLangId == html))";
    expect(evaluateWhen(clause, c)).toBe(true);
    expect(evaluateWhen(clause, ctx({ ...{ editorTextFocus: true, resourceScheme: "file", resourceLangId: "python" }, "config.minifier.enableMitify": true }))).toBe(false);
  });
});
