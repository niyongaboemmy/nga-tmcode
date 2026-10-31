import { describe, expect, it } from "vitest";
import { parseJsonc } from "../textmate/jsonc";
import { setJsonProperty } from "./jsonEdit";

const base = `{
  // Tabs for this project
  "editor.tabSize": 2, // two
  "files.exclude": "**/dist",
  "[python]": { "editor.tabSize": 4 }
}
`;

describe("setJsonProperty keeps comments and formatting", () => {
  it("replaces a value in place", () => {
    const out = setJsonProperty(base, "editor.tabSize", 4);
    expect(out).toContain('"editor.tabSize": 4, // two');
    expect(out).toContain("// Tabs for this project");
    expect(parseJsonc<Record<string, unknown>>(out)["[python]"]).toEqual({ "editor.tabSize": 4 });
  });

  it("adds a new key after the last one, with a comma", () => {
    const out = setJsonProperty(base, "editor.wordWrap", "on");
    expect(parseJsonc<Record<string, unknown>>(out)).toMatchObject({ "editor.tabSize": 2, "editor.wordWrap": "on" });
    expect(out).toContain('  "editor.wordWrap": "on"\n}');
  });

  it("removes a key with its comma and line", () => {
    const out = setJsonProperty(base, "files.exclude", undefined);
    expect(out).not.toContain("files.exclude");
    expect(parseJsonc<Record<string, unknown>>(out)).toEqual({ "editor.tabSize": 2, "[python]": { "editor.tabSize": 4 } });
    const last = setJsonProperty('{ "a": 1, "b": 2 }', "b", undefined);
    expect(parseJsonc(last)).toEqual({ a: 1 });
  });

  it("starts a file when there is none, and handles an empty object", () => {
    expect(parseJsonc(setJsonProperty("", "editor.tabSize", 4))).toEqual({ "editor.tabSize": 4 });
    expect(parseJsonc(setJsonProperty("{}", "x", true))).toEqual({ x: true });
    expect(parseJsonc(setJsonProperty('{\n  "a": 1,\n}', "b", 2))).toEqual({ a: 1, b: 2 });
  });
});
