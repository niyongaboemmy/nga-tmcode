import { describe, expect, it } from "vitest";
import { toKeybinding, groupOf } from "./contributions";
import { completionKind, toMonacoSelector, textEdits } from "./languageBridge";
import { monaco } from "../monaco/setup";

describe("contributed keybindings", () => {
  it("converts VS Code keys per OS", () => {
    expect(toKeybinding({ command: "x", key: "ctrl+shift+alt+f" }, "windows")).toBe("mod+alt+shift+f");
    expect(toKeybinding({ command: "x", key: "ctrl+shift+alt+f" }, "mac")).toBe("ctrl+alt+shift+f");
    expect(toKeybinding({ command: "x", key: "ctrl+f", mac: "cmd+f" }, "mac")).toBe("mod+f");
    expect(toKeybinding({ command: "x", key: "cmd+k cmd+f" }, "linux")).toBeNull();
    expect(toKeybinding({ command: "x", key: "ctrl+k ctrl+m" }, "linux")).toBe("mod+k mod+m");
    expect(toKeybinding({ command: "x" }, "mac")).toBeNull();
  });

  it("reads menu groups and orders", () => {
    expect(groupOf({ command: "x", group: "navigation@93" })).toEqual({ group: "navigation", order: 93 });
    expect(groupOf({ command: "x", group: "1_modification" })).toEqual({ group: "1_modification", order: 0 });
    expect(groupOf({ command: "x" })).toEqual({ group: "navigation", order: 0 });
  });
});

describe("Monaco bridging", () => {
  it("maps document selectors to TMCode's documents", () => {
    expect(toMonacoSelector([{ language: "javascript", scheme: "file" }])).toEqual([{ language: "javascript", scheme: "tmcode" }]);
    expect(toMonacoSelector([{ language: "markdown" }, { scheme: "git" }, { notebookType: "jupyter" }])).toEqual([{ language: "markdown" }]);
    expect(toMonacoSelector([{ pattern: "*.json" }])).toEqual([{ pattern: "**/*.json" }]);
    expect(toMonacoSelector([{ scheme: "*" }])).toEqual([{ language: "*" }]);
  });

  it("maps completion kinds between the two numberings", () => {
    expect(completionKind(13)).toBe(monaco.languages.CompletionItemKind.Keyword);
    expect(completionKind(18)).toBe(monaco.languages.CompletionItemKind.Folder);
    expect(completionKind(16)).toBe(monaco.languages.CompletionItemKind.File);
    expect(completionKind(undefined)).toBe(monaco.languages.CompletionItemKind.Property);
  });

  it("converts 0-based edits to Monaco's 1-based ranges", () => {
    expect(textEdits([{ range: [0, 0, 1, 2], text: "x" }, { range: [0, 0, 0, 0], text: "", eol: 2 }])).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 3 }, text: "x" },
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "", eol: 1 },
    ]);
  });
});

import { parseManifest } from "../extensions/manifest";

describe("code contributions in package.json", () => {
  it("reads commands, menus and keybindings (localised)", () => {
    const m = parseManifest(
      JSON.stringify({
        name: "fmt",
        publisher: "acme",
        main: "./out/extension.js",
        contributes: {
          commands: [{ command: "fmt.run", title: "%run%", category: "Fmt", icon: "$(sync)" }],
          menus: { "editor/context": [{ command: "fmt.run", when: "editorTextFocus", group: "navigation@2" }], commandPalette: [{ command: "fmt.run", when: "false" }] },
          keybindings: [{ command: "fmt.run", key: "ctrl+alt+f", mac: "cmd+alt+f", when: "editorTextFocus" }],
          configuration: { properties: { "fmt.x": { type: "boolean" } } },
        },
      }),
      { run: "Run Formatter" },
    );
    expect(m.main).toBe("./out/extension.js");
    expect(m.commands).toEqual([{ command: "fmt.run", title: "Run Formatter", category: "Fmt", icon: "sync", enablement: undefined }]);
    expect(m.menus["editor/context"][0]).toMatchObject({ command: "fmt.run", when: "editorTextFocus", group: "navigation@2" });
    expect(m.keybindings[0]).toMatchObject({ key: "ctrl+alt+f", mac: "cmd+alt+f" });
    // Code contributions are not "unsupported" for an extension that has code.
    expect(m.unsupported).toEqual([]);
  });
});
