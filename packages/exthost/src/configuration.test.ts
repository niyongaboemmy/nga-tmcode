import { describe, expect, it } from "vitest";
import { ConfigurationModel, affects, changedKeys, configurationDefaults, configurationProperties, nest } from "./configuration";

describe("configuration", () => {
  it("reads contributed properties with type defaults and localised text", () => {
    const props = configurationProperties(
      {
        configuration: [
          { title: "%t%", properties: { "p.a": { type: "boolean", description: "%d%" }, "p.b": { type: "number", default: 3 }, "p.c": { type: ["string", "null"] } } },
        ],
      },
      "Fallback",
      (s) => (s === "%t%" ? "Title" : s === "%d%" ? "Desc" : String(s ?? "")),
    );
    expect(props.map((p) => [p.key, p.default, p.title])).toEqual([
      ["p.a", false, "Title"],
      ["p.b", 3, "Title"],
      ["p.c", "", "Title"],
    ]);
    expect(props[0].description).toBe("Desc");
    expect(configurationDefaults({ configurationDefaults: { "[markdown]": { "editor.wordWrap": "on" } } })).toEqual({ "[markdown]": { "editor.wordWrap": "on" } });
  });

  it("nests dotted keys", () => {
    expect(nest({ "a.b": 1, "a.c.d": true, x: 2 })).toEqual({ a: { b: 1, c: { d: true } }, x: 2 });
  });

  it("layers user values over defaults and merges objects", () => {
    const m = new ConfigurationModel({ "prettier.tabWidth": 2, "prettier.semi": true, "files.exclude": { "**/.git": true } }, { "prettier.tabWidth": 4, "files.exclude": { "**/dist": true } });
    expect(m.getValue("prettier")).toEqual({ tabWidth: 4, semi: true });
    expect(m.getValue("prettier.semi")).toBe(true);
    expect(m.getValue("files.exclude")).toEqual({ "**/.git": true, "**/dist": true });
    const i = m.inspect<number>("prettier.tabWidth");
    expect([i.defaultValue, i.globalValue]).toEqual([2, 4]);
    // Values handed out are copies.
    (m.getValue("prettier") as Record<string, unknown>).tabWidth = 99;
    expect(m.getValue("prettier.tabWidth")).toBe(4);
  });

  it("applies [language] overrides", () => {
    const m = new ConfigurationModel({ "editor.tabSize": 4, "[python]": { "editor.tabSize": 8 } }, { "[python]": { "editor.insertSpaces": false } });
    expect(m.getValue("editor.tabSize")).toBe(4);
    expect(m.getValue("editor.tabSize", "python")).toBe(8);
    expect(m.getValue("editor", "python")).toEqual({ tabSize: 8, insertSpaces: false });
  });

  it("knows which sections a change affects", () => {
    const keys = changedKeys({ "a.b": 1, "x.y": 1 }, { "a.b": 2, "x.y": 1, "n.m": true });
    expect(keys.sort()).toEqual(["a.b", "n.m"]);
    expect(affects(keys, "a")).toBe(true);
    expect(affects(keys, "a.b")).toBe(true);
    expect(affects(keys, "a.b.c")).toBe(true);
    expect(affects(keys, "x")).toBe(false);
  });
});
