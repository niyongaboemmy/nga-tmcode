import { describe, expect, it } from "vitest";
import { readProfileJson } from "./profiles";

describe("profile files", () => {
  it("reads an exported profile and names it", () => {
    const p = readProfileJson(JSON.stringify({ name: "Web", settings: { "editor.fontSize": 16 }, languages: { python: { "editor.tabSize": 4 } }, keybindings: "[]" }));
    expect(p).toEqual({ name: "Web", data: { settings: { "editor.fontSize": 16 }, languages: { python: { "editor.tabSize": 4 } }, other: {}, keybindings: "[]" } });
  });
  it("refuses what isn't a profile", () => {
    expect(readProfileJson("not json")).toBeNull();
    expect(readProfileJson('{"name":"x"}')).toBeNull();
    expect(readProfileJson('{"settings":{}}')?.name).toBe("Imported");
  });
});
